/**
 * @module providers/gemini/capabilities/GeminiAudioTextToSpeechCapabilityImpl.ts
 * @description Provider implementations and capability adapters.
 */
import { GoogleGenAI } from "@google/genai";
import {
    AIProvider,
    AIRequest,
    AIResponse,
    AIResponseChunk,
    BaseProvider,
    CapabilityKeys,
    ClientTextToSpeechRequest,
    createAudioArtifact,
    MultiModalExecutionContext,
    NormalizedAudio,
    TextToSpeechCapability,
    TextToSpeechStreamCapability
} from "#root/index.js";

const DEFAULT_GEMINI_TTS_MODEL = "gemini-2.5-flash-preview-tts";
const DEFAULT_STREAM_BATCH_BYTES = 64 * 1024;

/**
 * Gemini text-to-speech implementation (non-streaming + streaming).
 *
 * Notes:
 * - Uses `models.generateContent`/`generateContentStream` with `responseModalities: ["AUDIO"]`.
 * - Normalizes inline audio parts to `NormalizedAudio`.
 * - Wraps raw PCM/L16 payloads into WAV for broad playback compatibility.
 */
/**
 * @public
 * @description Provider capability implementation for GeminiAudioTextToSpeechCapabilityImpl.
 */
export class GeminiAudioTextToSpeechCapabilityImpl
    implements TextToSpeechCapability<ClientTextToSpeechRequest>, TextToSpeechStreamCapability<ClientTextToSpeechRequest>
{
    constructor(
        private readonly _provider: BaseProvider,
        private readonly _client: GoogleGenAI
    ) {}

    /**
     * Synthesizes speech in a single non-streaming call.
     *
     * @param request Unified AI request containing TTS input/options/context
     * @param _ctx Optional multimodal execution context (unused by this capability)
     * @param signal Optional abort signal
     * @returns Provider-normalized TTS audio artifact response
     * @throws {Error} If input text is empty, request is aborted, or provider returns no audio data
     */
    async textToSpeech(
        request: AIRequest<ClientTextToSpeechRequest>,
        _ctx?: MultiModalExecutionContext,
        signal?: AbortSignal
    ): Promise<AIResponse<NormalizedAudio[]>> {
        this._provider.ensureInitialized();

        if (signal?.aborted) {
            throw new Error("Text-to-speech request aborted before execution");
        }

        const { input, options, context } = request;
        if (typeof input.text !== "string" || input.text.trim().length === 0) {
            throw new Error("TTS text must be a non-empty string");
        }

        const merged = this._provider.getMergedOptions(CapabilityKeys.AudioTextToSpeechCapabilityKey, options);
        const model = (merged.model ?? DEFAULT_GEMINI_TTS_MODEL).replace(/^models\//, "");
        // Gemini frequently reports L16/PCM-style audio; default to PCM until a chunk provides an explicit mime.
        const fallbackMimeType = "audio/pcm";

        // `responseModalities: ["AUDIO"]` is required or Gemini returns text-only candidates.
        const config: Record<string, unknown> = {
            responseModalities: ["AUDIO"],
            ...(merged.modelParams ?? {}),
            ...(merged.providerParams ?? {})
        };

        // SDK accepts either shorthand voice string or structured speechConfig object.
        if (input.voice || (merged.modelParams as any)?.voice) {
            config.speechConfig = input.voice ?? (merged.modelParams as any)?.voice;
        }
        if (input.instructions) {
            config.systemInstruction = input.instructions;
        }

        const response = await this._client.models.generateContent({
            model,
            contents: input.text,
            config
        });

        const responseId = response.responseId ?? context?.requestId ?? crypto.randomUUID();
        const audioChunks = this.extractInlineAudioChunks(response);

        if (audioChunks.length === 0) {
            throw new Error("Gemini TTS response did not contain audio data");
        }

        // Decode chunks to bytes first; concatenating raw base64 strings would corrupt binary output.
        const bytes = this.concatBase64Chunks(audioChunks.map((chunk) => chunk.base64));
        const mimeType = audioChunks.find((chunk) => chunk.mimeType)?.mimeType ?? fallbackMimeType;
        // Convert raw PCM-family payloads to WAV so saved artifacts are immediately playable.
        const playable = this.toPlayableAudio(bytes, mimeType);

        const artifact = createAudioArtifact({
            id: responseId,
            kind: "tts",
            mimeType: playable.mimeType,
            base64: playable.bytes.toString("base64"),
            raw: response
        });

        return {
            output: [artifact],
            multimodalArtifacts: { tts: [artifact] },
            id: responseId,
            rawResponse: response,
            metadata: {
                ...(context?.metadata ?? {}),
                provider: AIProvider.Gemini,
                model,
                status: "completed",
                requestId: context?.requestId
            }
        };
    }

    /**
     * Streams synthesized speech as incremental audio chunks and emits a final artifact.
     *
     * @param request Unified AI request containing TTS input/options/context
     * @param _ctx Optional multimodal execution context (unused by this capability)
     * @param signal Optional abort signal
     * @returns Async generator of TTS audio chunks and a terminal completion chunk
     * @throws {Error} If input text is empty before stream setup
     */
    async *textToSpeechStream(
        request: AIRequest<ClientTextToSpeechRequest>,
        _ctx?: MultiModalExecutionContext,
        signal?: AbortSignal
    ): AsyncGenerator<AIResponseChunk<NormalizedAudio[]>> {
        this._provider.ensureInitialized();

        const { input, options, context } = request;
        if (typeof input.text !== "string" || input.text.trim().length === 0) {
            throw new Error("TTS text must be a non-empty string");
        }

        const merged = this._provider.getMergedOptions(CapabilityKeys.AudioTextToSpeechStreamCapabilityKey, options);
        const model = (merged.model ?? DEFAULT_GEMINI_TTS_MODEL).replace(/^models\//, "");
        const fallbackMimeType = "audio/pcm";
        // Re-batch to a stable chunk size so downstream subscribers get predictable chunk sizesd.
        const batchSize = Math.max(1, Number(merged.generalParams?.audioStreamBatchSize ?? DEFAULT_STREAM_BATCH_BYTES));

        const config: Record<string, unknown> = {
            responseModalities: ["AUDIO"],
            ...(merged.modelParams ?? {}),
            ...(merged.providerParams ?? {})
        };

        if (input.voice || (merged.modelParams as any)?.voice) {
            config.speechConfig = input.voice ?? (merged.modelParams as any)?.voice;
        }
        if (input.instructions) {
            config.systemInstruction = input.instructions;
        }

        let responseId: string | undefined;
        let mimeType = fallbackMimeType;
        let chunkIndex = 0;
        const allBuffers: Buffer[] = [];
        let allBytesTotal = 0;
        try {
            const stream = await this._client.models.generateContentStream({
                model,
                contents: input.text,
                config
            });

            for await (const chunk of stream) {
                if (signal?.aborted) {
                    return;
                }

                // Keep one stable response id across all emitted chunks for this stream.
                responseId ??= chunk.responseId ?? context?.requestId ?? crypto.randomUUID();
                const audioChunks = this.extractInlineAudioChunks(chunk);

                for (const audioChunk of audioChunks) {
                    mimeType = audioChunk.mimeType ?? mimeType;
                    const buffer = Buffer.from(audioChunk.base64, "base64");
                    allBuffers.push(buffer);
                    allBytesTotal += buffer.byteLength;

                    for (let offset = 0; offset < buffer.byteLength; offset += batchSize) {
                        const slice = buffer.subarray(offset, Math.min(offset + batchSize, buffer.byteLength));
                        const artifact = createAudioArtifact({
                            id: `${responseId}-chunk-${chunkIndex++}`,
                            kind: "tts",
                            mimeType,
                            base64: slice.toString("base64")
                        });

                        yield {
                            // Incremental stream chunk: partial bytes, not final aggregate artifact.
                            done: false,
                            id: responseId,
                            delta: [artifact],
                            output: [artifact],
                            metadata: {
                                ...(context?.metadata ?? {}),
                                provider: AIProvider.Gemini,
                                model,
                                status: "incomplete",
                                requestId: context?.requestId
                            }
                        };
                    }
                }
            }

            if (allBuffers.length === 0) {
                throw new Error("Gemini TTS response did not contain audio data");
            }

            // Final artifact contains full concatenated payload for consumers that only inspect terminal output.
            const finalArtifact = createAudioArtifact({
                id: responseId ?? context?.requestId ?? crypto.randomUUID(),
                kind: "tts",
                ...(() => {
                    const playable = this.toPlayableAudio(Buffer.concat(allBuffers, allBytesTotal), mimeType);
                    return {
                        mimeType: playable.mimeType,
                        base64: playable.bytes.toString("base64")
                    };
                })()
            });

            yield {
                done: true,
                id: finalArtifact.id,
                output: [finalArtifact],
                multimodalArtifacts: { tts: [finalArtifact] },
                metadata: {
                    ...(context?.metadata ?? {}),
                    provider: AIProvider.Gemini,
                    model,
                    status: "completed",
                    requestId: context?.requestId
                }
            };
            return;
        } catch (err) {
            if (signal?.aborted) {
                return;
            }

            yield {
                // Terminal error chunk follows streaming contract used by other capabilities.
                output: [],
                delta: [],
                done: true,
                id: responseId ?? context?.requestId ?? crypto.randomUUID(),
                metadata: {
                    ...(context?.metadata ?? {}),
                    provider: AIProvider.Gemini,
                    model,
                    status: "error",
                    requestId: context?.requestId,
                    error: err instanceof Error ? err.message : String(err)
                }
            };
            return;
        }
    }

    /**
     * Extracts inline audio parts from Gemini candidate parts.
     * Falls back to `response.data` when available.
     *
     * @param response Gemini SDK response/chunk object
     * @returns List of base64 audio chunks with optional normalized mime type
     */
    private extractInlineAudioChunks(response: any): Array<{ base64: string; mimeType?: string }> {
        const chunks: Array<{ base64: string; mimeType?: string }> = [];
        const parts = response?.candidates?.[0]?.content?.parts;

        if (Array.isArray(parts)) {
            for (const part of parts) {
                const base64 = part?.inlineData?.data;
                if (typeof base64 === "string" && base64.length > 0) {
                    // Normalize provider mime variants up-front so later extension/format logic is consistent.
                    chunks.push({ base64, mimeType: this.normalizeGeminiAudioMimeType(part?.inlineData?.mimeType) });
                }
            }
        }

        if (chunks.length === 0 && typeof response?.data === "string" && response.data.length > 0) {
            // Some SDK paths expose aggregated inline audio via `response.data`.
            chunks.push({ base64: response.data, mimeType: undefined });
        }

        return chunks;
    }

    /**
     * Decodes and concatenates provider base64 chunks into one byte buffer.
     *
     * @param base64Chunks Ordered base64-encoded audio chunks
     * @returns Concatenated binary audio bytes
     */
    private concatBase64Chunks(base64Chunks: string[]): Buffer {
        // Keep decoding per chunk to avoid accidental UTF-8/base64 boundary issues.
        const buffers: Buffer[] = [];
        let total = 0;
        for (const value of base64Chunks) {
            const buffer = Buffer.from(value, "base64");
            buffers.push(buffer);
            total += buffer.byteLength;
        }
        return Buffer.concat(buffers, total);
    }

    /**
     * Converts raw PCM-style outputs into WAV so downstream playback works out of the box.
     *
     * @param bytes Raw audio bytes
     * @param mimeType Source mime type
     * @returns Playable audio bytes and corresponding mime type
     */
    private toPlayableAudio(bytes: Buffer, mimeType: string): { bytes: Buffer; mimeType: string } {
        const normalized = mimeType.split(";")[0]?.trim().toLowerCase();
        if (normalized === "audio/pcm" || normalized === "audio/l16" || normalized === "audio/linear16") {
            // Gemini commonly returns raw 16-bit mono PCM (L16). Wrap in WAV for broad player support.
            return { bytes: this.wrapPcm16LeAsWav(bytes, 24000, 1), mimeType: "audio/wav" };
        }
        return { bytes, mimeType };
    }

    /**
     * Builds a minimal WAV header around raw PCM16LE bytes.
     *
     * @param pcmBytes Raw PCM16LE payload
     * @param sampleRate Sample rate in Hz
     * @param channels Channel count (e.g. 1 mono, 2 stereo)
     * @returns WAV buffer (header + PCM payload)
     */
    private wrapPcm16LeAsWav(pcmBytes: Buffer, sampleRate: number, channels: number): Buffer {
        const bitsPerSample = 16;
        const blockAlign = (channels * bitsPerSample) / 8;
        const byteRate = sampleRate * blockAlign;
        const dataSize = pcmBytes.byteLength;
        const header = Buffer.alloc(44);

        header.write("RIFF", 0);
        header.writeUInt32LE(36 + dataSize, 4);
        header.write("WAVE", 8);
        header.write("fmt ", 12);
        header.writeUInt32LE(16, 16); // PCM fmt chunk size
        header.writeUInt16LE(1, 20); // PCM format
        header.writeUInt16LE(channels, 22);
        header.writeUInt32LE(sampleRate, 24);
        header.writeUInt32LE(byteRate, 28);
        header.writeUInt16LE(blockAlign, 32);
        header.writeUInt16LE(bitsPerSample, 34);
        header.write("data", 36);
        header.writeUInt32LE(dataSize, 40);

        return Buffer.concat([header, pcmBytes]);
    }

    /**
     * Normalizes Gemini mime variants (e.g. `audio/L16`, `audio/x-wav`) to canonical values.
     *
     * @param mimeType Provider-reported mime type (possibly with params/casing variants)
     * @returns Canonicalized mime type or `undefined` if input is unusable
     */
    private normalizeGeminiAudioMimeType(mimeType?: string): string | undefined {
        if (!mimeType) {
            return undefined;
        }

        const cleaned = mimeType.split(";")[0]?.trim().toLowerCase();
        if (!cleaned) {
            return undefined;
        }

        // Gemini can surface L16 aliases; normalize to internal PCM marker.
        if (cleaned === "audio/l16" || cleaned === "audio/linear16") {
            return "audio/pcm";
        }

        // Normalize historical wav alias for consistent extension mapping.
        if (cleaned === "audio/x-wav") {
            return "audio/wav";
        }

        return cleaned;
    }
}
