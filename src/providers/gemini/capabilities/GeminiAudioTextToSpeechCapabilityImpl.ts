import { GoogleGenAI } from "@google/genai";
import {
    AIRequest,
    AIResponse,
    AIResponseChunk,
    assertAudioBytesWithinLimit,
    AudioCapabilityError,
    BaseProvider,
    CapabilityKeys,
    ClientTextToSpeechRequest,
    createAudioArtifact,
    decodeBase64Audio,
    extractAudioErrorCode,
    extractAudioMimeInfo,
    extractResponseIdByKeys,
    MultiModalExecutionContext,
    NormalizedAudio,
    resolveAudioOutputMimeType,
    TextToSpeechCapability,
    TextToSpeechStreamCapability
} from "#root/index.js";
import {
    buildMetadata,
    extractGeminiAudioFromStreamResult,
    extractGeminiAudioPart,
    extractGeminiText,
    extractUsage,
    stripModelPrefix
} from "./shared/GeminiAudioUtils.js";

const DEFAULT_TTS_MODEL = "gemini-2.5-flash-preview-tts";
const DEFAULT_MAX_TTS_OUTPUT_BYTES = 8_388_608;
const DEFAULT_TTS_MAX_ATTEMPTS = 3;
const DEFAULT_TTS_RETRY_BASE_MS = 100;
const DEFAULT_TTS_RETRY_MAX_MS = 1_000;
const DEFAULT_TTS_RETRY_JITTER_RATIO = 0.2;
const DEFAULT_GEMINI_TTS_VOICE = "Kore";

/**
 * Gemini text-to-speech adapter.
 *
 * Keeps non-streaming and streaming TTS together in one dedicated capability file.
 */
export class GeminiAudioTextToSpeechCapabilityImpl implements
    TextToSpeechCapability<ClientTextToSpeechRequest, NormalizedAudio[]>,
    TextToSpeechStreamCapability<ClientTextToSpeechRequest, NormalizedAudio[]> {

    constructor(
        private readonly provider: BaseProvider,
        private readonly client: GoogleGenAI
    ) { }

    /**
     * Non-streaming text-to-speech synthesis.
     *
     * Requests audio modality from Gemini and normalizes the returned audio part.
     * If provider audio is PCM/L16 and caller requested WAV, PCM bytes are wrapped
     * in a WAV container to produce playable output.
     *
     * @param request Unified TTS request
     * @param _executionContext Optional execution context (unused)
     * @param signal Optional abort signal
     * @returns Normalized synthesized audio artifact response
     * @throws Error if input text is missing or no audio data is returned
     */
    async textToSpeech(
        request: AIRequest<ClientTextToSpeechRequest>,
        _executionContext?: MultiModalExecutionContext,
        signal?: AbortSignal
    ): Promise<AIResponse<NormalizedAudio[]>> {
        this.provider.ensureInitialized();
        const { input, options, context } = request;
        if (!input?.text) {
            throw new Error("Text-to-speech requires input text");
        }

        const merged = this.provider.getMergedOptions(CapabilityKeys.AudioTextToSpeechCapabilityKey, options);

        const ttsRuntime = this.readTtsRuntimeOptions(merged?.generalParams);
        const payload = this.buildTtsPayload(input, merged);
        const { response, audioPart, attemptsUsed, source, fallbackUsed } = await this.generateTtsWithRetry(
            payload,
            ttsRuntime.maxAttempts,
            ttsRuntime.retryBaseMs,
            ttsRuntime.retryMaxMs,
            ttsRuntime.retryJitterRatio,
            signal
        );

        const rawBytes = decodeBase64Audio(audioPart.data, "gemini.textToSpeech");
        assertAudioBytesWithinLimit(rawBytes.length, ttsRuntime.maxTtsOutputBytes, "gemini.textToSpeech");
        const normalizedAudio = this.normalizeTtsAudio(audioPart.data, audioPart.mimeType, input.format, audioPart.url);
        const normalizedBytes = decodeBase64Audio(normalizedAudio.base64, "gemini.textToSpeech.normalized");
        assertAudioBytesWithinLimit(normalizedBytes.length, ttsRuntime.maxTtsOutputBytes, "gemini.textToSpeech.normalized");
        const artifactId = extractResponseIdByKeys(response, ["responseId", "id"]) ?? context?.requestId ?? crypto.randomUUID();
        const output: NormalizedAudio[] = [
            createAudioArtifact({
                id: artifactId,
                kind: "tts",
                mimeType: normalizedAudio.mimeType,
                base64: normalizedAudio.base64,
                url: normalizedAudio.url,
                sampleRateHz: normalizedAudio.sampleRateHz,
                channels: normalizedAudio.channels,
                bitrate: normalizedAudio.bitrate
            })
        ];

        return {
            output,
            multimodalArtifacts: { audio: output },
            rawResponse: response,
            id: extractResponseIdByKeys(response, ["responseId", "id"]) ?? context?.requestId ?? crypto.randomUUID(),
            metadata: buildMetadata(context, merged.model, "completed", extractUsage(response), undefined, {
                audioRetryCount: Math.max(0, attemptsUsed - 1),
                audioFallbackUsed: fallbackUsed,
                audioSource: source
            })
        };
    }

    /**
     * Streaming text-to-speech synthesis.
     *
     * Emits incremental audio deltas from streamed audio parts and returns
     * a final normalized artifact assembled from all chunks.
     *
     * @param request Unified TTS request
     * @param _executionContext Optional execution context (unused)
     * @param signal Optional abort signal
     * @returns Async stream of normalized TTS chunks
     * @throws Error if input text is missing
     */
    async *textToSpeechStream(
        request: AIRequest<ClientTextToSpeechRequest>,
        _executionContext?: MultiModalExecutionContext,
        signal?: AbortSignal
    ): AsyncGenerator<AIResponseChunk<NormalizedAudio[]>> {
        this.provider.ensureInitialized();
        const { input, options, context } = request;
        if (!input?.text) {
            throw new Error("Text-to-speech requires input text");
        }

        const merged = this.provider.getMergedOptions(CapabilityKeys.AudioTextToSpeechStreamCapabilityKey, options);

        const requestId = context?.requestId ?? crypto.randomUUID();
        const artifactId = crypto.randomUUID();
        const chunkBytes: Buffer[] = [];
        let totalBytes = 0;
        let chunkMimeType: string | undefined;
        const fallbackMimeType = resolveAudioOutputMimeType(input.format, null, "wav");
        let responseId: string | undefined;
        const ttsRuntime = this.readTtsRuntimeOptions(merged?.generalParams);
        let attemptsUsed = 0;
        let streamSource = "gemini-generateContentStream";
        let streamFallbackUsed = false;
        const payload = this.buildTtsPayload(input, merged);

        try {
            for (let attempt = 1; attempt <= ttsRuntime.maxAttempts; attempt++) {
                attemptsUsed = attempt;
                const stream = await this.client.models.generateContentStream(payload as any);
                let emittedAnyAudioThisAttempt = false;

                for await (const chunk of stream) {
                    if (signal?.aborted) {
                        return;
                    }
                    responseId ??= chunk.responseId;
                    const audioPart = extractGeminiAudioPart(chunk);
                    if (!audioPart) {
                        continue;
                    }
                    emittedAnyAudioThisAttempt = true;
                    chunkMimeType ??= audioPart.mimeType;
                    const rawBytes = decodeBase64Audio(audioPart.data, "gemini.textToSpeechStream.delta");
                    chunkBytes.push(rawBytes);
                    totalBytes += rawBytes.length;
                    assertAudioBytesWithinLimit(totalBytes, ttsRuntime.maxTtsOutputBytes, "gemini.textToSpeechStream");

                    const chunkAudioInfo = extractAudioMimeInfo(chunkMimeType ?? fallbackMimeType);
                    const deltaArtifact = createAudioArtifact({
                        id: artifactId,
                        kind: "tts",
                        mimeType: chunkMimeType ?? fallbackMimeType,
                        base64: audioPart.data,
                        url: audioPart.url,
                        sampleRateHz: chunkAudioInfo.sampleRateHz,
                        channels: chunkAudioInfo.channels,
                        bitrate: chunkAudioInfo.bitrate
                    });

                    yield {
                        delta: [deltaArtifact],
                        done: false,
                        id: responseId ?? requestId,
                        metadata: buildMetadata(context, merged.model, "incomplete", undefined, requestId)
                    };
                }

                if (!emittedAnyAudioThisAttempt) {
                    const responseAudio = await extractGeminiAudioFromStreamResult(stream);
                    if (responseAudio) {
                        responseId ??= (stream as any)?.responseId;
                        chunkMimeType ??= responseAudio.mimeType;
                        const rawBytes = decodeBase64Audio(responseAudio.data, "gemini.textToSpeechStream.response");
                        chunkBytes.push(rawBytes);
                        totalBytes += rawBytes.length;
                        assertAudioBytesWithinLimit(totalBytes, ttsRuntime.maxTtsOutputBytes, "gemini.textToSpeechStream");
                        streamSource = "gemini-generateContentStream.response";
                    }
                }

                if (chunkBytes.length > 0) {
                    break;
                }

                if (attempt < ttsRuntime.maxAttempts) {
                    await this.delayWithBackoff(
                        attempt,
                        ttsRuntime.retryBaseMs,
                        ttsRuntime.retryMaxMs,
                        ttsRuntime.retryJitterRatio,
                        signal
                    );
                }
            }

            if (chunkBytes.length === 0) {
                const fallback = await this.textToSpeech(request, _executionContext, signal);
                streamFallbackUsed = true;
                yield {
                    delta: fallback.output,
                    output: fallback.output,
                    done: true,
                    id: fallback.id ?? requestId,
                    multimodalArtifacts: { audio: fallback.output },
                    metadata: {
                        ...(fallback.metadata ?? {}),
                        status: "completed",
                        audioFallbackUsed: true,
                        audioSource: "gemini-textToSpeech-fallback",
                        audioRetryCount: Math.max(0, attemptsUsed - 1)
                    }
                };
                return;
            }

            const finalRawBytes = Buffer.concat(chunkBytes);
            const normalizedAudio = this.normalizeTtsAudio(
                finalRawBytes.toString("base64"),
                chunkMimeType,
                input.format,
                undefined
            );
            const normalizedBytes = decodeBase64Audio(normalizedAudio.base64, "gemini.textToSpeechStream.final");
            assertAudioBytesWithinLimit(
                normalizedBytes.length,
                ttsRuntime.maxTtsOutputBytes,
                "gemini.textToSpeechStream.final"
            );
            const finalArtifact = createAudioArtifact({
                id: artifactId,
                kind: "tts",
                mimeType: normalizedAudio.mimeType,
                base64: normalizedAudio.base64,
                url: normalizedAudio.url,
                sampleRateHz: normalizedAudio.sampleRateHz,
                channels: normalizedAudio.channels,
                bitrate: normalizedAudio.bitrate
            });
            yield {
                delta: [finalArtifact],
                output: [finalArtifact],
                done: true,
                id: responseId ?? requestId,
                multimodalArtifacts: { audio: [finalArtifact] },
                metadata: buildMetadata(context, merged.model, "completed", undefined, requestId, {
                    audioRetryCount: Math.max(0, attemptsUsed - 1),
                    audioFallbackUsed: streamFallbackUsed,
                    audioSource: streamSource
                })
            };
        } catch (err) {
            if (signal?.aborted) {
                return;
            }
            yield {
                done: true,
                id: responseId ?? requestId,
                error: err instanceof Error ? err.message : String(err),
                metadata: buildMetadata(context, merged.model, "error", undefined, requestId, {
                    audioErrorCode: extractAudioErrorCode(err)
                })
            };
        }
    }


    /**
     * Normalizes provider audio output into requested client format.
     *
     * Current conversion:
     * - PCM/L16/linear16 -> WAV container when `requestedFormat` resolves to WAV.
     *
     * @param base64 Raw provider audio payload
     * @param providerMimeType Mime type emitted by provider
     * @param requestedFormat Caller-requested output format
     * @returns Normalized base64 audio + resolved mime type
     */
    private normalizeTtsAudio(
        base64: string,
        providerMimeType: string | undefined,
        requestedFormat: string | undefined,
        providerUrl?: string
    ): { base64: string; mimeType: string; url?: string; sampleRateHz?: number; channels?: number; bitrate?: number } {
        const requestedMimeType = resolveAudioOutputMimeType(requestedFormat, null, "wav");
        const sourceMime = providerMimeType?.toLowerCase() ?? "";
        const sourceDetails = extractAudioMimeInfo(providerMimeType);

        // Gemini TTS commonly returns raw PCM (L16/LINEAR16). Wrap in WAV when caller requests WAV.
        if (
            requestedMimeType === "audio/wav" &&
            (sourceMime.includes("audio/l16") || sourceMime.includes("linear16") || sourceMime.includes("audio/pcm"))
        ) {
            // Provider returned raw PCM; wrap it in RIFF/WAV for broad player compatibility.
            const pcmBytes = Buffer.from(base64, "base64");
            const wavBytes = this.wrapPcm16ToWav(pcmBytes, 24000, 1, 16);
            return {
                base64: wavBytes.toString("base64"),
                mimeType: "audio/wav",
                sampleRateHz: sourceDetails.sampleRateHz ?? 24_000,
                channels: sourceDetails.channels ?? 1,
                bitrate: sourceDetails.bitrate
            };
        }

        const resolvedMime = providerMimeType ?? requestedMimeType;
        const resolvedDetails = extractAudioMimeInfo(resolvedMime);
        return {
            base64,
            mimeType: resolvedMime,
            ...(providerUrl ? { url: providerUrl } : {}),
            sampleRateHz: sourceDetails.sampleRateHz ?? resolvedDetails.sampleRateHz,
            channels: sourceDetails.channels ?? resolvedDetails.channels,
            bitrate: sourceDetails.bitrate ?? resolvedDetails.bitrate
        };
    }

    /**
     * Wraps raw PCM16LE payload in a RIFF/WAVE container.
     *
     * @param pcmData Raw PCM bytes
     * @param sampleRate Sample rate in Hz
     * @param channels Number of channels
     * @param bitsPerSample Bits per sample (typically 16)
     * @returns WAV bytes containing the PCM payload
     */
    private wrapPcm16ToWav(pcmData: Buffer, sampleRate: number, channels: number, bitsPerSample: number): Buffer {
        const blockAlign = (channels * bitsPerSample) / 8;
        const byteRate = sampleRate * blockAlign;
        const dataSize = pcmData.length;
        const buffer = Buffer.alloc(44 + dataSize);

        buffer.write("RIFF", 0);
        buffer.writeUInt32LE(36 + dataSize, 4);
        buffer.write("WAVE", 8);
        buffer.write("fmt ", 12);
        buffer.writeUInt32LE(16, 16); // PCM chunk size
        buffer.writeUInt16LE(1, 20); // PCM format
        buffer.writeUInt16LE(channels, 22);
        buffer.writeUInt32LE(sampleRate, 24);
        buffer.writeUInt32LE(byteRate, 28);
        buffer.writeUInt16LE(blockAlign, 32);
        buffer.writeUInt16LE(bitsPerSample, 34);
        buffer.write("data", 36);
        buffer.writeUInt32LE(dataSize, 40);
        pcmData.copy(buffer, 44);

        return buffer;
    }

    /**
     * Builds Gemini speech configuration for prebuilt voices.
     *
     * @param voice Optional voice name
     * @returns Gemini speechConfig object
     */
    private buildSpeechConfig(voice?: string) {
        return {
            voiceConfig: {
                prebuiltVoiceConfig: {
                    voiceName: voice ?? DEFAULT_GEMINI_TTS_VOICE
                }
            }
        };
    }

    /**
     * Retries Gemini TTS generation until an audio part is present.
     *
     * @param payload Gemini generateContent payload
     * @param attempts Maximum attempts
     * @param signal Optional abort signal
     * @returns Response and extracted audio part
     * @throws Error if all attempts return no audio data
     */
    private async generateTtsWithRetry(
        payload: Parameters<GoogleGenAI["models"]["generateContent"]>[0],
        attempts: number,
        retryBaseMs: number,
        retryMaxMs: number,
        retryJitterRatio: number,
        signal?: AbortSignal
    ): Promise<{
        response: any;
        audioPart: { data: string; mimeType?: string; url?: string };
        attemptsUsed: number;
        source: string;
        fallbackUsed: boolean;
    }> {
        let lastResponse: any;

        for (let attempt = 1; attempt <= attempts; attempt++) {
            const response = await this.client.models.generateContent(payload);
            lastResponse = response;

            if (signal?.aborted) {
                throw new AudioCapabilityError("AUDIO_REQUEST_ABORTED", "Request aborted");
            }

            const audioPart = extractGeminiAudioPart(response);
            if (audioPart) {
                return {
                    response,
                    audioPart,
                    attemptsUsed: attempt,
                    source: "gemini-generateContent",
                    fallbackUsed: false
                };
            }
            // Missing audio can be transient; continue retries.
            if (attempt < attempts) {
                await this.delayWithBackoff(attempt, retryBaseMs, retryMaxMs, retryJitterRatio, signal);
            }
        }

        const streamFallback = await this.generateTtsFromStreamFallback(payload, signal);
        if (streamFallback) {
            return {
                ...streamFallback,
                attemptsUsed: attempts,
                source: "gemini-generateContentStream-fallback",
                fallbackUsed: true
            };
        }

        const fallbackText = extractGeminiText(lastResponse);
        throw new AudioCapabilityError(
            "AUDIO_EMPTY_RESPONSE",
            fallbackText
                ? `Gemini TTS response did not contain audio data (last text response: ${fallbackText.slice(0, 120)})`
                : "Gemini TTS response did not contain audio data",
            { attempts }
        );
    }

    private async generateTtsFromStreamFallback(
        payload: Parameters<GoogleGenAI["models"]["generateContent"]>[0],
        signal?: AbortSignal
    ): Promise<{ response: any; audioPart: { data: string; mimeType?: string; url?: string } } | undefined> {
        if (typeof this.client.models.generateContentStream !== "function") {
            return undefined;
        }

        try {
            const stream = await this.client.models.generateContentStream(payload as any);
            let lastChunk: any;
            const audioBytes: Buffer[] = [];
            let mimeType: string | undefined;
            let url: string | undefined;

            for await (const chunk of stream) {
                if (signal?.aborted) {
                    throw new AudioCapabilityError("AUDIO_REQUEST_ABORTED", "Request aborted");
                }
                lastChunk = chunk;
                const audioPart = extractGeminiAudioPart(chunk);
                if (!audioPart) {
                    continue;
                }
                audioBytes.push(decodeBase64Audio(audioPart.data, "gemini.generateTtsFromStreamFallback"));
                mimeType ??= audioPart.mimeType;
                url ??= audioPart.url;
            }

            if (audioBytes.length === 0) {
                return undefined;
            }

            return {
                response: lastChunk,
                audioPart: {
                    data: Buffer.concat(audioBytes).toString("base64"),
                    mimeType,
                    ...(url ? { url } : {})
                }
            };
        } catch (err) {
            if (signal?.aborted) {
                throw err;
            }
            return undefined;
        }
    }

    private buildTtsPayload(
        input: ClientTextToSpeechRequest,
        merged: any
    ): Parameters<GoogleGenAI["models"]["generateContent"]>[0] {
        return {
            model: stripModelPrefix(merged.model ?? DEFAULT_TTS_MODEL),
            contents: [{ role: "user", parts: [{ text: input.text }] }],
            config: {
                responseModalities: ["AUDIO"],
                speechConfig: this.buildSpeechConfig(input.voice),
                ...(merged.modelParams ?? {})
            },
            ...(merged.providerParams ?? {})
        };
    }

    private readTtsRuntimeOptions(generalParams: Record<string, unknown> | undefined) {
        return {
            maxAttempts: Math.max(1, Number(generalParams?.geminiTtsMaxAttempts ?? DEFAULT_TTS_MAX_ATTEMPTS)),
            retryBaseMs: Number(generalParams?.geminiTtsRetryBaseMs ?? DEFAULT_TTS_RETRY_BASE_MS),
            retryMaxMs: Number(generalParams?.geminiTtsRetryMaxMs ?? DEFAULT_TTS_RETRY_MAX_MS),
            retryJitterRatio: Number(generalParams?.geminiTtsRetryJitterRatio ?? DEFAULT_TTS_RETRY_JITTER_RATIO),
            maxTtsOutputBytes: Number(generalParams?.maxTtsOutputBytes ?? DEFAULT_MAX_TTS_OUTPUT_BYTES)
        };
    }

    private async delayWithBackoff(attempt: number, baseMs: number, maxMs: number, jitterRatio: number, signal?: AbortSignal) {
        const safeBase = Number.isFinite(baseMs) && baseMs > 0 ? baseMs : 0;
        const safeMax = Number.isFinite(maxMs) && maxMs > 0 ? maxMs : safeBase;
        const exp = Math.min(safeMax, safeBase * Math.pow(2, Math.max(0, attempt - 1)));
        const jitter = exp * (Number.isFinite(jitterRatio) ? Math.max(0, jitterRatio) : 0);
        const ms = Math.max(0, Math.round(exp + (Math.random() * 2 - 1) * jitter));

        if (ms <= 0) {
            return;
        }
        await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => {
                signal?.removeEventListener("abort", onAbort);
                resolve();
            }, ms);
            const onAbort = () => {
                clearTimeout(timer);
                reject(new AudioCapabilityError("AUDIO_REQUEST_ABORTED", "Request aborted"));
            };
            if (signal) {
                if (signal.aborted) {
                    onAbort();
                    return;
                }
                signal.addEventListener("abort", onAbort, { once: true });
            }
        });
    }
}
