import OpenAI from "openai";
import {
    AIRequest,
    AIResponse,
    AIResponseChunk,
    assertAudioBytesWithinLimit,
    AudioCapabilityError,
    BaseProvider,
    CapabilityKeys,
    ClientTextToSpeechRequest,
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
    createSpeechArtifact,
    extractNonDataUrl,
} from "./shared/OpenAIAudioUtils.js";

const DEFAULT_TTS_MODEL = "gpt-4o-mini-tts";
const DEFAULT_MAX_TTS_OUTPUT_BYTES = 8_388_608;
const DEFAULT_TTS_VOICE = "alloy";

/**
 * OpenAI text-to-speech adapter.
 *
 * Keeps non-streaming and streaming TTS together in one dedicated capability file.
 */
export class OpenAIAudioTextToSpeechCapabilityImpl implements
    TextToSpeechCapability<ClientTextToSpeechRequest, NormalizedAudio[]>,
    TextToSpeechStreamCapability<ClientTextToSpeechRequest, NormalizedAudio[]>
{
    constructor(
        private readonly provider: BaseProvider,
        private readonly client: OpenAI
    ) {}

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

        const response = await this.client.audio.speech.create(
            {
                model: merged.model ?? DEFAULT_TTS_MODEL,
                input: input.text,
                voice: input.voice ?? DEFAULT_TTS_VOICE,
                response_format: (input.format as any) ?? "mp3",
                stream_format: input.streamFormat as any,
                instructions: input.instructions,
                speed: input.speed,
                ...(merged.modelParams ?? {}),
                ...(merged.providerParams ?? {})
            },
            { signal }
        );

        const maxTtsOutputBytes = Number(merged?.generalParams?.maxTtsOutputBytes ?? DEFAULT_MAX_TTS_OUTPUT_BYTES);
        const bytes = Buffer.from(await response.arrayBuffer());
        if (bytes.length === 0) {
            throw new AudioCapabilityError("AUDIO_EMPTY_RESPONSE", "OpenAI TTS response did not contain audio bytes");
        }
        assertAudioBytesWithinLimit(bytes.length, maxTtsOutputBytes, "openai.textToSpeech");
        const base64 = bytes.toString("base64");
        const mimeType = resolveAudioOutputMimeType(input.format, response.headers.get("content-type"), "mp3");
        const outputAudioInfo = extractAudioMimeInfo(response.headers.get("content-type") ?? mimeType);
        const outputUrl = extractNonDataUrl(response);
        const artifactId = extractResponseIdByKeys(response, ["id"]) ?? context?.requestId ?? crypto.randomUUID();
        const output = [
            {
                id: artifactId,
                kind: "tts",
                mimeType,
                base64,
                ...(outputUrl ? { url: outputUrl } : {}),
                sampleRateHz: outputAudioInfo.sampleRateHz,
                channels: outputAudioInfo.channels,
                bitrate: outputAudioInfo.bitrate
            } satisfies NormalizedAudio
        ];

        return {
            output,
            multimodalArtifacts: { audio: output },
            rawResponse: response,
            id: extractResponseIdByKeys(response, ["id"]) ?? context?.requestId ?? crypto.randomUUID(),
            metadata: buildMetadata(context, merged.model, "completed", context?.requestId, {
                audioRetryCount: 0,
                audioFallbackUsed: false,
                audioSource: "openai-speech-nonstream"
            })
        };
    }

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
        const accumulatedChunks: Buffer[] = [];
        let totalBytes = 0;
        let responseId: string | undefined;
        const maxTtsOutputBytes = Number(merged?.generalParams?.maxTtsOutputBytes ?? DEFAULT_MAX_TTS_OUTPUT_BYTES);

        try {
            const response = await this.client.audio.speech.create(
                {
                    model: merged.model ?? DEFAULT_TTS_MODEL,
                    input: input.text,
                    voice: input.voice ?? DEFAULT_TTS_VOICE,
                    response_format: (input.format as any) ?? "mp3",
                    stream_format: (input.streamFormat as any) ?? "audio",
                    instructions: input.instructions,
                    speed: input.speed,
                    ...(merged.modelParams ?? {}),
                    ...(merged.providerParams ?? {})
                },
                { signal }
            );

            responseId = (response as any)?.id ?? undefined;
            const mimeType = resolveAudioOutputMimeType(input.format, response.headers.get("content-type"), "mp3");
            const outputAudioInfo = extractAudioMimeInfo(response.headers.get("content-type") ?? mimeType);
            const streamBody = (response as any).body as ReadableStream<Uint8Array> | undefined;

            if (!streamBody?.getReader) {
                // Fallback path for non-stream responses: emit one completed chunk.
                const bytes = Buffer.from(await response.arrayBuffer());
                if (bytes.length === 0) {
                    throw new AudioCapabilityError(
                        "AUDIO_EMPTY_RESPONSE",
                        "OpenAI TTS stream fallback response did not contain audio bytes"
                    );
                }
                assertAudioBytesWithinLimit(bytes.length, maxTtsOutputBytes, "openai.textToSpeechStream.fallback");
                const base64 = bytes.toString("base64");
                const finalArtifact = createSpeechArtifact(artifactId, mimeType, base64, extractNonDataUrl(response));
                finalArtifact.sampleRateHz = outputAudioInfo.sampleRateHz;
                finalArtifact.channels = outputAudioInfo.channels;
                finalArtifact.bitrate = outputAudioInfo.bitrate;

                yield {
                    delta: [finalArtifact],
                    output: [finalArtifact],
                    done: true,
                    id: responseId ?? requestId,
                    multimodalArtifacts: { audio: [finalArtifact] },
                    metadata: buildMetadata(context, merged.model, "completed", requestId, {
                        audioRetryCount: 0,
                        audioFallbackUsed: true,
                        audioSource: "openai-speech-stream-nonstream-fallback"
                    })
                };
                return;
            }

            const reader = streamBody.getReader();
            while (true) {
                if (signal?.aborted) {
                    await reader.cancel();
                    return;
                }

                const { done, value } = await reader.read();
                if (done) {
                    break;
                }
                if (!value || value.length === 0) {
                    continue;
                }

                const bytes = Buffer.from(value);
                accumulatedChunks.push(bytes);
                totalBytes += bytes.length;
                assertAudioBytesWithinLimit(totalBytes, maxTtsOutputBytes, "openai.textToSpeechStream");
                const deltaBase64 = bytes.toString("base64");
                const deltaArtifact = createSpeechArtifact(
                    artifactId,
                    mimeType,
                    deltaBase64,
                    extractNonDataUrl(response)
                );
                deltaArtifact.sampleRateHz = outputAudioInfo.sampleRateHz;
                deltaArtifact.channels = outputAudioInfo.channels;
                deltaArtifact.bitrate = outputAudioInfo.bitrate;

                // Delta chunk carries only incremental audio payload.
                yield {
                    delta: [deltaArtifact],
                    done: false,
                    id: responseId ?? requestId,
                    metadata: buildMetadata(context, merged.model, "incomplete", requestId, {
                        audioRetryCount: 0,
                        audioFallbackUsed: false,
                        audioSource: "openai-speech-stream"
                    })
                };
            }

            if (totalBytes === 0) {
                throw new AudioCapabilityError("AUDIO_EMPTY_RESPONSE", "OpenAI TTS stream produced no audio chunks");
            }
            const finalBytes = Buffer.concat(accumulatedChunks);
            const finalBase64 = finalBytes.toString("base64");
            decodeBase64Audio(finalBase64, "openai.textToSpeechStream.final");
            const finalArtifact = createSpeechArtifact(
                artifactId,
                mimeType,
                finalBase64,
                extractNonDataUrl(response)
            );
            finalArtifact.sampleRateHz = outputAudioInfo.sampleRateHz;
            finalArtifact.channels = outputAudioInfo.channels;
            finalArtifact.bitrate = outputAudioInfo.bitrate;

            yield {
                delta: [finalArtifact],
                output: [finalArtifact],
                done: true,
                id: responseId ?? requestId,
                multimodalArtifacts: { audio: [finalArtifact] },
                metadata: buildMetadata(context, merged.model, "completed", requestId, {
                    audioRetryCount: 0,
                    audioFallbackUsed: false,
                    audioSource: "openai-speech-stream"
                })
            };
        } catch (err) {
            const audioErrorCode = extractAudioErrorCode(err);
            yield {
                done: true,
                error: err instanceof Error ? err.message : String(err),
                id: responseId ?? requestId,
                metadata: buildMetadata(context, merged.model, "error", requestId, {
                    audioErrorCode
                })
            };
        }
    }
}
