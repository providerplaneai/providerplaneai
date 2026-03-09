/**
 * @module providers/openai/capabilities/OpenAIAudioTextToSpeechCapabilityImpl.ts
 * @description Provider implementations and capability adapters.
 */
import OpenAI from "openai";
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

const DEFAULT_OPENAI_TTS_MODEL = "gpt-4o-mini-tts";
const DEFAULT_OPENAI_TTS_VOICE = "alloy";
const DEFAULT_STREAM_BATCH_BYTES = 64 * 1024;

const FORMAT_TO_MIME: Record<string, string> = {
    mp3: "audio/mpeg",
    wav: "audio/wav",
    flac: "audio/flac",
    aac: "audio/aac",
    opus: "audio/opus",
    ogg: "audio/ogg",
    pcm: "audio/pcm"
};

type OpenAITtsResponse = Response & { id?: string; url?: string };

/**
 * OpenAI text-to-speech implementation using the dedicated audio speech endpoint.
 *
 * Provides:
 * - Non-streaming synthesis (`textToSpeech`)
 * - Streaming synthesis (`textToSpeechStream`)
 */
/**
 * @public
 * @description Provider capability implementation for OpenAIAudioTextToSpeechCapabilityImpl.
 */
export class OpenAIAudioTextToSpeechCapabilityImpl
    implements TextToSpeechCapability<ClientTextToSpeechRequest>, TextToSpeechStreamCapability<ClientTextToSpeechRequest>
{
    /**
     * Creates a new OpenAI TTS capability delegate.
     *
     * @param provider Parent provider for lifecycle/config access
     * @param client Initialized OpenAI SDK client
     */
    constructor(
        private readonly provider: BaseProvider,
        private readonly client: OpenAI
    ) {}

    /**
     * Synthesizes speech in a single non-streaming request.
     *
     * @param request Unified AI request containing TTS input/options/context
     * @param _ctx Optional multimodal execution context (unused by this capability)
     * @param signal Optional abort signal
     * @returns Provider-normalized TTS audio artifact response
     * @throws {Error} If input text is empty or request is aborted before execution
     */
    async textToSpeech(
        request: AIRequest<ClientTextToSpeechRequest>,
        _ctx?: MultiModalExecutionContext,
        signal?: AbortSignal
    ): Promise<AIResponse<NormalizedAudio[]>> {
        // Ensure provider has been initialized with credentials + client
        this.provider.ensureInitialized();

        if (signal?.aborted) {
            throw new Error("Text-to-speech request aborted before execution");
        }

        const { input, options, context } = request;
        // TTS requires source text; fail fast before any provider call.
        if (typeof input.text !== "string" || input.text.trim().length === 0) {
            throw new Error("TTS text must be a non-empty string");
        }

        // Merge capability defaults with request-level overrides once for deterministic behavior.
        const merged = this.provider.getMergedOptions(CapabilityKeys.AudioTextToSpeechCapabilityKey, options);
        const model = merged.model ?? DEFAULT_OPENAI_TTS_MODEL;
        const format = input.format ?? merged.modelParams?.response_format ?? "mp3";

        // Dedicated speech endpoint (not Responses API) for binary audio output.
        const response = (await this.client.audio.speech.create(
            {
                model,
                input: input.text,
                voice: input.voice ?? merged.modelParams?.voice ?? DEFAULT_OPENAI_TTS_VOICE,
                response_format: format as any,
                ...(input.instructions !== undefined ? { instructions: input.instructions } : {}),
                ...(input.speed !== undefined ? { speed: input.speed } : {}),
                ...(input.streamFormat !== undefined ? { stream_format: input.streamFormat } : {}),
                ...(merged.providerParams ?? {})
            },
            { signal }
        )) as OpenAITtsResponse;

        // Read full payload for non-streaming path, then normalize to a single artifact.
        const bytes = new Uint8Array(await response.arrayBuffer());

        const artifact = createAudioArtifact({
            kind: "tts",
            id: response.id ?? context?.requestId ?? crypto.randomUUID(),
            mimeType: this.resolveAudioOutputMimeType(format, response.headers?.get("content-type")),
            base64: Buffer.from(bytes).toString("base64"),
            url: this.sanitizeOpenAITtsUrl(response.url)
        });

        return {
            output: [artifact],
            multimodalArtifacts: { tts: [artifact] },
            id: artifact.id,
            rawResponse: response,
            metadata: {
                ...(context?.metadata ?? {}),
                provider: AIProvider.OpenAI,
                model: merged.model,
                status: response.status === 200 ? "completed" : "error",
                requestId: context?.requestId
            }
        };
    }

    /**
     * Streams synthesized speech as incremental audio chunks plus a final full artifact.
     *
     * @param request Unified AI request containing TTS input/options/context
     * @param _ctx Optional multimodal execution context (unused by this capability)
     * @param signal Optional abort signal
     * @returns Async generator of audio chunk deltas and a final terminal chunk
     * @throws {Error} If input text is empty or unsupported stream format is requested
     */
    async *textToSpeechStream(
        request: AIRequest<ClientTextToSpeechRequest>,
        _ctx?: MultiModalExecutionContext,
        signal?: AbortSignal
    ): AsyncGenerator<AIResponseChunk<NormalizedAudio[]>> {
        this.provider.ensureInitialized();

        const { input, options, context } = request;

        // Match non-streaming validation so both code paths enforce identical input rules.
        if (typeof input.text !== "string" || input.text.trim().length === 0) {
            throw new Error("TTS text must be a non-empty string");
        }

        // SSE event framing is not wired yet; current stream mode emits raw audio bytes only.
        if (input.streamFormat === "sse") {
            throw new Error("SSE stream format is not supported yet");
        }

        // Use stream-specific capability defaults so batching can differ from non-streaming behavior.
        const merged = this.provider.getMergedOptions(CapabilityKeys.AudioTextToSpeechStreamCapabilityKey, options);
        const model = merged.model ?? DEFAULT_OPENAI_TTS_MODEL;
        const format = input.format ?? merged.modelParams?.response_format ?? "mp3";
        // Batch size controls chunk granularity seen by downstream subscribers/jobs.
        const batchSize = Math.max(1, Number(merged.generalParams?.audioStreamBatchSize ?? DEFAULT_STREAM_BATCH_BYTES));
        let responseId: string | undefined;

        try {
            // Request server-side streaming bytes by forcing stream_format=audio.
            const response = (await this.client.audio.speech.create(
                {
                    model,
                    input: input.text,
                    voice: input.voice ?? merged.modelParams?.voice ?? DEFAULT_OPENAI_TTS_VOICE,
                    response_format: format as any,
                    stream_format: "audio",
                    ...(input.instructions !== undefined ? { instructions: input.instructions } : {}),
                    ...(input.speed !== undefined ? { speed: input.speed } : {}),
                    ...(merged.providerParams ?? {})
                },
                { signal }
            )) as OpenAITtsResponse;

            responseId = response.id ?? context?.requestId ?? crypto.randomUUID();
            const mimeType = this.resolveAudioOutputMimeType(format, response.headers?.get("content-type"));
            let chunkIndex = 0;
            // Keep emitted chunks for final "done" artifact parity with image stream finalization style.
            const chunks: Buffer[] = [];

            // Hard guard: this runtime must expose a readable body stream for true streaming semantics.
            if (!response.body) {
                throw new Error("OpenAI TTS stream response body is not readable in this runtime");
            }

            const reader = response.body.getReader();
            try {
                while (true) {
                    // Cooperative cancellation for long-running streams.
                    if (signal?.aborted) {
                        return;
                    }

                    const { done, value } = await reader.read();
                    if (done) {
                        break;
                    }
                    if (!value || value.length === 0) {
                        continue;
                    }

                    // Re-batch provider chunk to stable, configurable chunk sizes for consumers.
                    const buffer = Buffer.from(value);
                    chunks.push(buffer);

                    for (let offset = 0; offset < buffer.byteLength; offset += batchSize) {
                        const slice = buffer.subarray(offset, Math.min(offset + batchSize, buffer.byteLength));
                        const artifact = createAudioArtifact({
                            kind: "tts",
                            id: `${responseId}-chunk-${chunkIndex++}`,
                            mimeType,
                            base64: slice.toString("base64")
                        });

                        yield {
                            // Streaming phase: emit incremental audio bytes and keep job status incomplete.
                            done: false,
                            id: responseId,
                            delta: [artifact],
                            output: [artifact],
                            metadata: {
                                ...(context?.metadata ?? {}),
                                provider: AIProvider.OpenAI,
                                model,
                                status: "incomplete",
                                requestId: context?.requestId
                            }
                        };
                    }
                }
            } finally {
                reader.releaseLock();
            }

            // Final completion chunk carries the full audio payload for single-artifact consumers.
            const allBytes = Buffer.concat(chunks);
            const finalArtifact = createAudioArtifact({
                kind: "tts",
                id: responseId,
                mimeType,
                base64: allBytes.toString("base64"),
                url: this.sanitizeOpenAITtsUrl(response.url)
            });

            yield {
                done: true,
                id: responseId,
                output: [finalArtifact],
                // Preserve multimodal timeline compatibility for completed TTS outputs.
                multimodalArtifacts: { tts: [finalArtifact] },
                metadata: {
                    ...(context?.metadata ?? {}),
                    provider: AIProvider.OpenAI,
                    model,
                    status: "completed",
                    requestId: context?.requestId
                }
            };
        } catch (err) {
            // Abort is treated as caller-controlled cancellation, not a provider error event.
            if (signal?.aborted) {
                return;
            }

            yield {
                // Streaming error contract: terminal chunk with empty output + diagnostic metadata.
                output: [],
                delta: [],
                done: true,
                id: responseId ?? context?.requestId ?? crypto.randomUUID(),
                metadata: {
                    ...(context?.metadata ?? {}),
                    provider: AIProvider.OpenAI,
                    model,
                    status: "error",
                    requestId: context?.requestId,
                    error: err instanceof Error ? err.message : String(err)
                }
            };
        }
    }

    /**
     * Drops endpoint URLs that are not stable download links and should not be exposed as artifact URLs.
     *
     * @param url Potential provider URL from response payload
     * @returns Safe artifact URL or `undefined` when URL is endpoint-only/invalid
     */
    private sanitizeOpenAITtsUrl(url?: string): string | undefined {
        if (!url) {
            return undefined;
        }
        try {
            const parsed = new URL(url);
            if (parsed.pathname === "/v1/audio/speech") {
                return undefined;
            }
            return url;
        } catch {
            return undefined;
        }
    }

    resolveAudioOutputMimeType(format?: string, header?: string | null): string {
        const fromHeader = header?.split(";")[0]?.trim();
        if (fromHeader) {
            return fromHeader;
        }
        const fromFormat = format ? FORMAT_TO_MIME[format.toLowerCase()] : undefined;
        return fromFormat ?? "audio/mpeg";
    }
}
