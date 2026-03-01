import { GoogleGenAI } from "@google/genai";
import {
    AIProvider,
    AIRequest,
    AIResponse,
    AIResponseChunk,
    AudioTranscriptionCapability,
    AudioTranscriptionStreamCapability,
    AudioTranslationCapability,
    BaseProvider,
    CapabilityKeys,
    ClientAudioTranscriptionRequest,
    ClientAudioTranslationRequest,
    ClientTextToSpeechRequest,
    MultiModalExecutionContext,
    NormalizedAudio,
    TextToSpeechCapability,
    TextToSpeechStreamCapability,
    AudioCapabilityError,
    assertAudioBytesWithinLimit,
    createAudioArtifact,
    decodeBase64Audio,
    extractAudioMimeInfo,
    resolveAudioInputMimeType,
    resolveAudioOutputMimeType
} from "#root/index.js";

const DEFAULT_TRANSCRIPTION_MODEL = "gemini-2.5-flash";
const DEFAULT_TTS_MODEL = "gemini-2.5-flash-preview-tts";
const DEFAULT_TRANSCRIPTION_PROMPT = "Transcribe the provided audio. Return plain text only.";
const DEFAULT_TRANSLATION_TARGET_LANGUAGE = "en";
const DEFAULT_AUDIO_STREAM_BATCH_SIZE = 64;
const DEFAULT_MAX_TTS_OUTPUT_BYTES = 8_388_608;
const DEFAULT_TTS_MAX_ATTEMPTS = 3;
const DEFAULT_TTS_RETRY_BASE_MS = 100;
const DEFAULT_TTS_RETRY_MAX_MS = 1_000;
const DEFAULT_TTS_RETRY_JITTER_RATIO = 0.2;
const DEFAULT_GEMINI_TTS_VOICE = "Kore";

/**
 * Gemini audio capability adapter.
 *
 * Gemini does not expose OpenAI-style dedicated audio endpoints, so these methods
 * adapt audio workflows through `models.generateContent` / `generateContentStream`.
 *
 * Notes:
 * - Transcription and translation are prompt-driven over inline audio parts.
 * - TTS uses Gemini audio response parts (`inlineData`) and normalizes output to `NormalizedAudio`.
 * - Streaming methods emit incremental deltas and a terminal chunk for consistency with AIClient orchestration.
 */
export class GeminiAudioCapabilityImpl
    implements
        AudioTranscriptionCapability<ClientAudioTranscriptionRequest, NormalizedAudio[]>,
        AudioTranscriptionStreamCapability<ClientAudioTranscriptionRequest, NormalizedAudio[]>,
        AudioTranslationCapability<ClientAudioTranslationRequest, NormalizedAudio[]>,
        TextToSpeechCapability<ClientTextToSpeechRequest, NormalizedAudio[]>,
        TextToSpeechStreamCapability<ClientTextToSpeechRequest, NormalizedAudio[]>
{
    /**
     * @param provider Owning provider instance
     * @param client Initialized Gemini SDK client
     */
    constructor(
        private readonly provider: BaseProvider,
        private readonly client: GoogleGenAI
    ) {}

    /**
     * Non-streaming audio transcription.
     *
     * Converts input audio to inline base64, prompts Gemini for transcript text,
     * and returns a normalized transcription artifact.
     *
     * @param request Unified audio transcription request
     * @param _executionContext Optional execution context (unused)
     * @param signal Optional abort signal
     * @returns Normalized transcription artifact response
     * @throws Error if input file is missing or request is aborted
     */
    async transcribeAudio(
        request: AIRequest<ClientAudioTranscriptionRequest>,
        _executionContext?: MultiModalExecutionContext,
        signal?: AbortSignal
    ): Promise<AIResponse<NormalizedAudio[]>> {
        this.provider.ensureInitialized();
        const { input, options, context } = request;
        if (!input?.file) {
            throw new Error("Audio transcription requires an input file");
        }

        const merged = this.getMergedOptions(
            CapabilityKeys.AudioTranscriptionCapabilityKey,
            options,
            DEFAULT_TRANSCRIPTION_MODEL
        );

        const audio = await this.normalizeAudioInput(input.file, input.mimeType, input.filename);
        // Gemini expects inline audio bytes in the request payload.
        const response = await this.client.models.generateContent({
            model: this.stripModelPrefix(merged.model ?? DEFAULT_TRANSCRIPTION_MODEL),
            contents: this.buildAudioContents(input.prompt ?? DEFAULT_TRANSCRIPTION_PROMPT, audio),
            config: {
                ...(merged.modelParams ?? {})
            },
            ...(merged.providerParams ?? {})
        });

        if (signal?.aborted) {
            throw new Error("Request aborted");
        }

        const transcript = this.extractGeminiText(response);
        const artifactId = this.extractResponseId(response) ?? context?.requestId ?? crypto.randomUUID();
        const output = [this.createTranscriptionArtifact(audio.mimeType, transcript, input.language, artifactId)];

        return {
            output,
            multimodalArtifacts: { audio: output },
            rawResponse: response,
            id: this.extractResponseId(response) ?? context?.requestId ?? crypto.randomUUID(),
            metadata: this.buildMetadata(context, merged.model, "completed", this.extractUsage(response))
        };
    }

    /**
     * Streaming audio transcription.
     *
     * Uses Gemini text stream transport and batches delta text into
     * incremental transcription chunks. Emits a terminal chunk with
     * `multimodalArtifacts.audio`.
     *
     * @param request Unified audio transcription request
     * @param _executionContext Optional execution context (unused)
     * @param signal Optional abort signal
     * @returns Async stream of normalized transcription chunks
     * @throws Error if input file is missing
     */
    async *transcribeAudioStream(
        request: AIRequest<ClientAudioTranscriptionRequest>,
        _executionContext?: MultiModalExecutionContext,
        signal?: AbortSignal
    ): AsyncGenerator<AIResponseChunk<NormalizedAudio[]>> {
        this.provider.ensureInitialized();
        const { input, options, context } = request;
        if (!input?.file) {
            throw new Error("Audio transcription requires an input file");
        }

        const merged = this.getMergedOptions(
            CapabilityKeys.AudioTranscriptionStreamCapabilityKey,
            options,
            DEFAULT_TRANSCRIPTION_MODEL
        );

        const audio = await this.normalizeAudioInput(input.file, input.mimeType, input.filename);
        const batchSize = Number(merged?.generalParams?.audioStreamBatchSize ?? DEFAULT_AUDIO_STREAM_BATCH_SIZE);
        const requestId = context?.requestId ?? crypto.randomUUID();
        const artifactId = crypto.randomUUID();
        let responseId: string | undefined;
        let accumulatedText = "";
        let buffer = "";

        try {
            // Gemini streams text tokens; audio stays in request input only.
            const stream = await this.client.models.generateContentStream({
                model: this.stripModelPrefix(merged.model ?? DEFAULT_TRANSCRIPTION_MODEL),
                contents: this.buildAudioContents(input.prompt ?? DEFAULT_TRANSCRIPTION_PROMPT, audio),
                config: {
                    ...(merged.modelParams ?? {})
                },
                ...(merged.providerParams ?? {})
            });

            for await (const chunk of stream) {
                if (signal?.aborted) {
                    return;
                }

                responseId ??= chunk.responseId;
                const delta = chunk.text ?? "";
                if (!delta) {
                    continue;
                }

                buffer += delta;
                accumulatedText += delta;

                if (buffer.length >= batchSize) {
                    const deltaArtifact = this.createTranscriptionArtifact(audio.mimeType, buffer, input.language, artifactId);
                    yield {
                        delta: [deltaArtifact],
                        done: false,
                        id: responseId ?? requestId,
                        metadata: this.buildMetadata(context, merged.model, "incomplete", undefined, requestId)
                    };
                    buffer = "";
                }
            }

            if (buffer.length > 0) {
                const deltaArtifact = this.createTranscriptionArtifact(audio.mimeType, buffer, input.language, artifactId);
                yield {
                    delta: [deltaArtifact],
                    done: false,
                    id: responseId ?? requestId,
                    metadata: this.buildMetadata(context, merged.model, "incomplete", undefined, requestId)
                };
            }

            const finalArtifact = this.createTranscriptionArtifact(audio.mimeType, accumulatedText, input.language, artifactId);
            yield {
                delta: [finalArtifact],
                output: [finalArtifact],
                done: true,
                id: responseId ?? requestId,
                multimodalArtifacts: { audio: [finalArtifact] },
                metadata: this.buildMetadata(context, merged.model, "completed", undefined, requestId)
            };
        } catch (err) {
            if (signal?.aborted) {
                return;
            }

            yield {
                done: true,
                id: responseId ?? requestId,
                error: err instanceof Error ? err.message : String(err),
                metadata: this.buildMetadata(context, merged.model, "error", undefined, requestId, {
                    audioErrorCode: this.extractAudioErrorCode(err)
                })
            };
        }
    }

    /**
     * Non-streaming audio translation.
     *
     * Gemini translation here is prompt-driven (audio input + translated text output),
     * unlike OpenAI's dedicated audio translation endpoint contract.
     *
     * @param request Unified audio translation request
     * @param _executionContext Optional execution context (unused)
     * @param signal Optional abort signal
     * @returns Normalized translated transcript artifact response
     * @throws Error if input file is missing or request is aborted
     */
    async translateAudio(
        request: AIRequest<ClientAudioTranslationRequest>,
        _executionContext?: MultiModalExecutionContext,
        signal?: AbortSignal
    ): Promise<AIResponse<NormalizedAudio[]>> {
        this.provider.ensureInitialized();
        const { input, options, context } = request;
        if (!input?.file) {
            throw new Error("Audio translation requires an input file");
        }

        const targetLanguage = input.targetLanguage ?? DEFAULT_TRANSLATION_TARGET_LANGUAGE;
        const merged = this.getMergedOptions(
            CapabilityKeys.AudioTranslationCapabilityKey,
            options,
            DEFAULT_TRANSCRIPTION_MODEL
        );

        const audio = await this.normalizeAudioInput(input.file, input.mimeType, input.filename);
        const response = await this.client.models.generateContent({
            model: this.stripModelPrefix(merged.model ?? DEFAULT_TRANSCRIPTION_MODEL),
            contents: this.buildAudioContents(
                input.prompt
                    ? `${input.prompt}\n\nTranslate the spoken audio into ${targetLanguage}. Return only the translated text.`
                    : `Translate the spoken audio into ${targetLanguage}. Return only the translated text.`,
                audio
            ),
            config: {
                ...(merged.modelParams ?? {})
            },
            ...(merged.providerParams ?? {})
        });

        if (signal?.aborted) {
            throw new Error("Request aborted");
        }

        const transcript = this.extractGeminiText(response);
        const inputAudioInfo = this.extractAudioMimeInfo(audio.mimeType);
        const artifactId = this.extractResponseId(response) ?? context?.requestId ?? crypto.randomUUID();
        const output: NormalizedAudio[] = [
            createAudioArtifact({
                id: artifactId,
                kind: "translation",
                mimeType: audio.mimeType,
                transcript,
                language: targetLanguage,
                sampleRateHz: inputAudioInfo.sampleRateHz,
                channels: inputAudioInfo.channels,
                bitrate: inputAudioInfo.bitrate
            })
        ];

        return {
            output,
            multimodalArtifacts: { audio: output },
            rawResponse: response,
            id: this.extractResponseId(response) ?? context?.requestId ?? crypto.randomUUID(),
            metadata: this.buildMetadata(context, merged.model, "completed", this.extractUsage(response))
        };
    }

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

        const merged = this.getMergedOptions(CapabilityKeys.AudioTextToSpeechCapabilityKey, options, DEFAULT_TTS_MODEL);

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
        const artifactId = this.extractResponseId(response) ?? context?.requestId ?? crypto.randomUUID();
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
            id: this.extractResponseId(response) ?? context?.requestId ?? crypto.randomUUID(),
            metadata: this.buildMetadata(context, merged.model, "completed", this.extractUsage(response), undefined, {
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

        const merged = this.getMergedOptions(CapabilityKeys.AudioTextToSpeechStreamCapabilityKey, options, DEFAULT_TTS_MODEL);

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
                    const audioPart = this.extractGeminiAudioPart(chunk);
                    if (!audioPart) {
                        continue;
                    }
                    emittedAnyAudioThisAttempt = true;
                    chunkMimeType ??= audioPart.mimeType;
                    const rawBytes = decodeBase64Audio(audioPart.data, "gemini.textToSpeechStream.delta");
                    chunkBytes.push(rawBytes);
                    totalBytes += rawBytes.length;
                    assertAudioBytesWithinLimit(totalBytes, ttsRuntime.maxTtsOutputBytes, "gemini.textToSpeechStream");

                    const chunkAudioInfo = this.extractAudioMimeInfo(chunkMimeType ?? fallbackMimeType);
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
                        metadata: this.buildMetadata(context, merged.model, "incomplete", undefined, requestId)
                    };
                }

                if (!emittedAnyAudioThisAttempt) {
                    const responseAudio = await this.extractGeminiAudioFromStreamResult(stream);
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
                metadata: this.buildMetadata(context, merged.model, "completed", undefined, requestId, {
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
                metadata: this.buildMetadata(context, merged.model, "error", undefined, requestId, {
                    audioErrorCode: this.extractAudioErrorCode(err)
                })
            };
        }
    }

    private async extractGeminiAudioFromStreamResult(
        stream: any
    ): Promise<{ data: string; mimeType?: string; url?: string } | undefined> {
        const possibleResponses = [stream?.response, stream?.finalResponse, stream?.result];

        for (const candidate of possibleResponses) {
            let resolved: any;
            if (candidate && typeof candidate.then === "function") {
                try {
                    resolved = await candidate;
                } catch {
                    resolved = undefined;
                }
            } else {
                resolved = candidate;
            }

            const audioPart = this.extractGeminiAudioPart(resolved);
            if (audioPart) {
                return audioPart;
            }
        }
        return undefined;
    }

    /**
     * Builds a normalized transcription artifact.
     *
     * @param mimeType Input audio mime type
     * @param transcript Transcript text
     * @param language Optional language hint
     * @param id Optional deterministic artifact id
     * @returns Normalized transcription artifact
     */
    private createTranscriptionArtifact(mimeType: string, transcript: string, language?: string, id?: string): NormalizedAudio {
        const details = this.extractAudioMimeInfo(mimeType);
        return createAudioArtifact({
            id: id ?? crypto.randomUUID(),
            kind: "transcription",
            mimeType,
            transcript,
            language,
            sampleRateHz: details.sampleRateHz,
            channels: details.channels,
            bitrate: details.bitrate
        });
    }

    /**
     * Extracts best-effort text from Gemini response shape.
     * @param response Raw Gemini response/chunk
     * @returns Concatenated text content, or empty string when unavailable
     */
    private extractGeminiText(response: any): string {
        if (typeof response?.text === "string") {
            return response.text;
        }
        const parts = response?.candidates?.[0]?.content?.parts;
        if (!Array.isArray(parts)) {
            return "";
        }
        return parts
            .map((p: any) => (typeof p?.text === "string" ? p.text : ""))
            .filter(Boolean)
            .join("");
    }

    /**
     * Extracts the first inline audio part from a Gemini response chunk.
     * @param response Raw Gemini response/chunk
     * @returns Audio payload + mime type when present
     */
    private extractGeminiAudioPart(response: any): { data: string; mimeType?: string; url?: string } | undefined {
        for (const part of this.extractGeminiContentParts(response)) {
            const inlineData = part?.inlineData ?? part?.inline_data;
            const data = inlineData?.data;
            if (typeof data === "string" && data.length > 0) {
                const rawUrl =
                    part?.fileData?.fileUri ??
                    part?.fileData?.uri ??
                    part?.file_data?.file_uri ??
                    part?.file_data?.uri ??
                    part?.url ??
                    inlineData?.url;
                const mimeType = inlineData?.mimeType ?? inlineData?.mime_type;
                return {
                    data,
                    mimeType: typeof mimeType === "string" ? mimeType : undefined,
                    url: typeof rawUrl === "string" && /^https?:\/\//i.test(rawUrl) ? rawUrl : undefined
                };
            }
        }
        return undefined;
    }

    private extractGeminiContentParts(response: any): any[] {
        const roots = [response, response?.response, response?.data].filter(Boolean);
        const parts: any[] = [];
        for (const root of roots) {
            const candidates = root?.candidates;
            if (!Array.isArray(candidates)) {
                continue;
            }
            for (const candidate of candidates) {
                const candidateParts = candidate?.content?.parts;
                if (Array.isArray(candidateParts)) {
                    parts.push(...candidateParts);
                }
            }
        }
        return parts;
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
        const sourceDetails = this.extractAudioMimeInfo(providerMimeType);

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
        const resolvedDetails = this.extractAudioMimeInfo(resolvedMime);
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
     * Extracts usage metadata from Gemini responses when available.
     *
     * @param response Raw Gemini response/chunk
     * @returns Token usage fields if present
     */
    private extractUsage(response: any): {
        inputTokens?: number;
        outputTokens?: number;
        totalTokens?: number;
    } {
        const usage = response?.usageMetadata;
        if (!usage) {
            return {};
        }
        return {
            inputTokens: usage.promptTokenCount,
            outputTokens: usage.candidatesTokenCount,
            totalTokens: usage.totalTokenCount
        };
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
     * Removes optional `models/` prefix for Gemini SDK model values.
     *
     * @param model Model identifier
     * @returns Model identifier without `models/` prefix
     */
    private stripModelPrefix(model: string): string {
        return model.replace(/^models\//, "");
    }

    /**
     * Resolves provider merged options for a specific capability.
     *
     * @param capability Capability key
     * @param options Per-request options
     * @param defaultModel Fallback model when options.model is not set
     * @returns Merged options from provider defaults + request overrides
     */
    private getMergedOptions(capability: string, options: AIRequest<unknown>["options"] | undefined, defaultModel: string) {
        return this.provider.getMergedOptions(capability, {
            model: options?.model ?? defaultModel,
            modelParams: options?.modelParams,
            providerParams: options?.providerParams,
            generalParams: options?.generalParams
        });
    }

    /**
     * Builds a Gemini `contents` payload containing prompt + inline audio.
     *
     * @param prompt Instruction text
     * @param audio Normalized inline audio payload
     * @returns Gemini contents array for generateContent/generateContentStream
     */
    private buildAudioContents(prompt: string, audio: { base64: string; mimeType: string }) {
        return [
            {
                role: "user",
                parts: [{ text: prompt }, { inlineData: { mimeType: audio.mimeType, data: audio.base64 } }]
            }
        ];
    }

    /**
     * Builds normalized metadata payload for AI responses/chunks.
     *
     * @param context Request context
     * @param model Resolved model
     * @param status Execution status
     * @param usage Optional usage fields
     * @param requestIdOverride Optional request id override for streaming paths
     * @returns Metadata object
     */
    private buildMetadata(
        context: AIRequest<unknown>["context"] | undefined,
        model: string | undefined,
        status: "incomplete" | "completed" | "error",
        usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number },
        requestIdOverride?: string,
        extras?: Record<string, unknown>
    ) {
        return {
            ...(context?.metadata ?? {}),
            provider: AIProvider.Gemini,
            model,
            status,
            requestId: requestIdOverride ?? context?.requestId,
            ...(usage ?? {}),
            ...(extras ?? {})
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

            const audioPart = this.extractGeminiAudioPart(response);
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

        const fallbackText = this.extractGeminiText(lastResponse);
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
                const audioPart = this.extractGeminiAudioPart(chunk);
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
        merged: ReturnType<GeminiAudioCapabilityImpl["getMergedOptions"]>
    ): Parameters<GoogleGenAI["models"]["generateContent"]>[0] {
        return {
            model: this.stripModelPrefix(merged.model ?? DEFAULT_TTS_MODEL),
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

    private extractAudioMimeInfo(mimeType: string | undefined): {
        sampleRateHz?: number;
        channels?: number;
        bitrate?: number;
    } {
        return extractAudioMimeInfo(mimeType);
    }

    private extractResponseId(response: unknown): string | undefined {
        if (!response || typeof response !== "object") {
            return undefined;
        }
        const direct = response as Record<string, unknown>;
        if (typeof direct["responseId"] === "string") {
            return direct["responseId"] as string;
        }
        return typeof direct["id"] === "string" ? (direct["id"] as string) : undefined;
    }

    private extractAudioErrorCode(err: unknown): string | undefined {
        if (err instanceof AudioCapabilityError) {
            return err.code;
        }
        if (!(err instanceof Error) || typeof err.message !== "string") {
            return undefined;
        }
        const match = err.message.match(/\[(AUDIO_[A-Z_]+)\]/);
        return match?.[1];
    }

    /**
     * Converts supported client audio input sources into inline base64 + mime type.
     *
     * Intentional contract:
     * - String input must be a Data URL.
     * - Local file path reading is NOT done here (caller responsibility).
     *
     * @param input Client audio input source
     * @param explicitMimeType Optional mime type hint
     * @param filename Optional filename hint for extension-based detection
     * @returns Normalized base64 audio payload and mime type
     * @throws Error when input source is unsupported
     */
    private async normalizeAudioInput(
        input: ClientAudioTranscriptionRequest["file"],
        explicitMimeType?: string,
        filename?: string
    ): Promise<{ base64: string; mimeType: string }> {
        const mimeType = resolveAudioInputMimeType(input, explicitMimeType, filename);

        if (typeof input === "string") {
            if (input.startsWith("data:")) {
                const [header, payload] = input.split(",", 2);
                if (!payload) {
                    throw new AudioCapabilityError("AUDIO_INVALID_PAYLOAD", "Invalid audio data URL");
                }
                const headerMime = header.match(/^data:([^;]+);base64$/i)?.[1];
                return {
                    base64: payload,
                    mimeType: explicitMimeType ?? headerMime ?? mimeType
                };
            }
            throw new AudioCapabilityError(
                "AUDIO_UNSUPPORTED_INPUT",
                "String audio input must be a data URL. Provide bytes/stream/blob for local files."
            );
        }

        if (typeof Buffer !== "undefined" && Buffer.isBuffer(input)) {
            return { base64: input.toString("base64"), mimeType };
        }

        if (input instanceof Uint8Array) {
            return { base64: Buffer.from(input).toString("base64"), mimeType };
        }

        if (input instanceof ArrayBuffer) {
            return { base64: Buffer.from(new Uint8Array(input)).toString("base64"), mimeType };
        }

        if ((input as any)?.arrayBuffer && typeof (input as any).arrayBuffer === "function") {
            // Browser/File-like objects expose bytes via arrayBuffer().
            const arr = await (input as any).arrayBuffer();
            return { base64: Buffer.from(new Uint8Array(arr)).toString("base64"), mimeType };
        }

        if (this.isReadableStream(input)) {
            // Gemini inlineData requires full base64 payload, so stream input is buffered once here.
            const chunks: Buffer[] = [];
            for await (const chunk of input as any) {
                if (typeof chunk === "string") {
                    chunks.push(Buffer.from(chunk));
                } else if (Buffer.isBuffer(chunk)) {
                    chunks.push(chunk);
                } else if (chunk instanceof Uint8Array) {
                    chunks.push(Buffer.from(chunk));
                }
            }
            return { base64: Buffer.concat(chunks).toString("base64"), mimeType };
        }

        throw new AudioCapabilityError("AUDIO_UNSUPPORTED_INPUT", "Unsupported audio input source");
    }

    /**
     * Best-effort Node readable stream guard for async iterable streams.
     *
     * @param value Unknown input
     * @returns True when value behaves like a Node readable async iterable stream
     */
    private isReadableStream(value: unknown): value is NodeJS.ReadableStream {
        return !!value && typeof value === "object" && Symbol.asyncIterator in (value as object);
    }
}
