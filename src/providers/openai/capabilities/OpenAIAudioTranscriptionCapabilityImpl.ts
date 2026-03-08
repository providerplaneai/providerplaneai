import OpenAI from "openai";
import { toFile } from "openai/uploads";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import {
    AIProvider,
    AIRequest,
    AIResponse,
    AIResponseChunk,
    AudioTranscriptionCapability,
    AudioTranscriptionStreamCapability,
    BaseProvider,
    CapabilityKeys,
    ClientAudioTranscriptionRequest,
    MultiModalExecutionContext,
    NormalizedChatMessage,
    NormalizedTextPart
} from "#root/index.js";

const DEFAULT_OPENAI_AUDIO_TRANSCRIPTION_MODEL = "gpt-4o-transcribe";

/**
 * OpenAI audio transcription capability implementation.
 *
 * Uses the dedicated Audio Transcriptions endpoint (`/v1/audio/transcriptions`).
 *
 * This implementation intentionally does not use the Responses API for transcription.
 */
export class OpenAIAudioTranscriptionCapabilityImpl
    implements
        AudioTranscriptionCapability<ClientAudioTranscriptionRequest>,
        AudioTranscriptionStreamCapability<ClientAudioTranscriptionRequest>
{
    /**
     * Creates a new OpenAI audio transcription capability delegate.
     *
     * @param provider Parent provider for lifecycle/config access
     * @param client Initialized OpenAI SDK client
     */
    constructor(
        private readonly provider: BaseProvider,
        private readonly client: OpenAI
    ) {}

    /**
     * Transcribes input audio into text using OpenAI's non-streaming transcription endpoint.
     *
     * Steps:
     * - Validate request payload
     * - Merge capability options
     * - Normalize file input for multipart upload
     * - Call OpenAI transcription endpoint
     * - Normalize transcript to chat artifact output
     *
     * @param request Unified AI request containing transcription input/options/context
     * @param _ctx Optional multimodal execution context (unused by this capability)
     * @param signal Optional abort signal
     * @returns Provider-normalized transcription output as chat message artifacts
     * @throws {Error} If input is invalid, request is aborted, or upload conversion fails
     */
    async transcribeAudio(
        request: AIRequest<ClientAudioTranscriptionRequest>,
        _ctx: MultiModalExecutionContext,
        signal?: AbortSignal
    ): Promise<AIResponse<NormalizedChatMessage[]>> {
        // Guard provider lifecycle to prevent SDK usage before initialization.
        this.provider.ensureInitialized();

        if (signal?.aborted) {
            throw new Error("Audio transcription request aborted before execution");
        }

        const { input, options, context } = request;
        if (!input?.file) {
            throw new Error("Audio transcription requires a non-empty 'file' input");
        }

        const merged = this.provider.getMergedOptions(CapabilityKeys.AudioTranscriptionCapabilityKey, options);
        const model = merged.model ?? DEFAULT_OPENAI_AUDIO_TRANSCRIPTION_MODEL;

        // Normalize all supported caller file shapes into OpenAI upload format.
        const uploadFile = await this.toUploadableAudioFile(input.file, input.filename, input.mimeType);
        // Dedicated transcription endpoint for speech-to-text (not Responses API).
        const response = await this.client.audio.transcriptions.create(
            {
                file: uploadFile as any,
                model,
                ...(input.language !== undefined ? { language: input.language } : {}),
                ...(input.prompt !== undefined ? { prompt: input.prompt } : {}),
                ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
                ...(input.responseFormat !== undefined ? { response_format: input.responseFormat as any } : {}),
                ...(input.include !== undefined ? { include: input.include as any } : {}),
                ...(merged.modelParams ?? {}),
                ...(merged.providerParams ?? {})
            },
            { signal }
        );

        const responseId = context?.requestId ?? crypto.randomUUID();
        const text = this.extractTranscriptionText(response);

        // Keep output contract aligned with AudioCapability: transcript comes back as chat text.
        const message = this.createAssistantTextMessage({
            id: responseId,
            text,
            model,
            status: "completed",
            requestContext: context,
            raw: response
        });

        return {
            output: [message],
            multimodalArtifacts: { chat: [message] },
            id: responseId,
            rawResponse: response,
            metadata: {
                ...(context?.metadata ?? {}),
                provider: AIProvider.OpenAI,
                model,
                status: "completed",
                requestId: context?.requestId
            }
        };
    }

    /**
     * Streams transcription deltas from OpenAI and emits a final completed transcript chunk.
     *
     * Emits:
     * - `done: false` chunks for `transcript.text.delta` events
     * - one terminal `done: true` chunk on `transcript.text.done`
     * - one terminal `done: true` error chunk on failure
     *
     * @param request Unified AI request containing transcription input/options/context
     * @param _ctx Optional multimodal execution context (unused by this capability)
     * @param signal Optional abort signal
     * @returns Async generator of transcription delta and completion chunks
     * @throws {Error} If input is invalid or streaming response shape is unexpected
     */
    async *transcribeAudioStream(
        request: AIRequest<ClientAudioTranscriptionRequest>,
        _ctx: MultiModalExecutionContext,
        signal?: AbortSignal
    ): AsyncGenerator<AIResponseChunk<NormalizedChatMessage[]>> {
        // Guard provider lifecycle to prevent SDK usage before initialization.
        this.provider.ensureInitialized();

        const { input, options, context } = request;
        if (!input?.file) {
            throw new Error("Audio transcription requires a non-empty 'file' input");
        }

        const merged = this.provider.getMergedOptions(CapabilityKeys.AudioTranscriptionStreamCapabilityKey, options);
        const model = merged.model ?? DEFAULT_OPENAI_AUDIO_TRANSCRIPTION_MODEL;

        const responseId: string | undefined = context?.requestId ?? crypto.randomUUID();
        let accumulatedText = "";

        try {
            if (signal?.aborted) {
                return;
            }

            const uploadFile = await this.toUploadableAudioFile(input.file, input.filename, input.mimeType);
            // Request event stream from OpenAI transcription endpoint.
            const streamOrResponse = await this.client.audio.transcriptions.create(
                {
                    file: uploadFile as any,
                    model,
                    stream: true,
                    ...(input.language !== undefined ? { language: input.language } : {}),
                    ...(input.prompt !== undefined ? { prompt: input.prompt } : {}),
                    ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
                    ...(input.responseFormat !== undefined ? { response_format: input.responseFormat as any } : {}),
                    ...(input.include !== undefined ? { include: input.include as any } : {}),
                    ...(merged.modelParams ?? {}),
                    ...(merged.providerParams ?? {})
                },
                { signal }
            );

            // Runtime drift guard: streaming path must return an async iterable event stream.
            if (!this.isAsyncIterable(streamOrResponse)) {
                throw new Error("OpenAI transcription stream did not return an async iterable stream");
            }

            for await (const event of streamOrResponse) {
                if (signal?.aborted) {
                    return;
                }

                // The OpenAI stream uses typed event names for incremental and terminal transcript phases.
                const eventType = event?.type;

                if (eventType === "transcript.text.delta") {
                    // Delta carries incremental text; publish both delta and accumulated output.
                    const deltaText = typeof event?.delta === "string" ? event.delta : "";
                    if (!deltaText) {
                        continue;
                    }

                    accumulatedText += deltaText;
                    const deltaMessage = this.createAssistantTextMessage({
                        id: `${responseId}-delta-${crypto.randomUUID()}`,
                        text: deltaText,
                        model,
                        status: "incomplete",
                        requestContext: context,
                        raw: event
                    });
                    const outputMessage = this.createAssistantTextMessage({
                        id: responseId,
                        text: accumulatedText,
                        model,
                        status: "incomplete",
                        requestContext: context
                    });

                    yield {
                        done: false,
                        id: responseId,
                        delta: [deltaMessage],
                        output: [outputMessage],
                        metadata: {
                            ...(context?.metadata ?? {}),
                            provider: AIProvider.OpenAI,
                            model,
                            status: "incomplete",
                            requestId: context?.requestId
                        }
                    };
                    continue;
                }

                if (eventType === "transcript.text.done") {
                    // Done event is authoritative final transcript for this stream.
                    const finalText = typeof event?.text === "string" ? event.text : accumulatedText;
                    accumulatedText = finalText;

                    const finalMessage = this.createAssistantTextMessage({
                        id: responseId,
                        text: accumulatedText,
                        model,
                        status: "completed",
                        requestContext: context,
                        raw: event
                    });

                    yield {
                        done: true,
                        id: responseId,
                        output: [finalMessage],
                        multimodalArtifacts: { chat: [finalMessage] },
                        metadata: {
                            ...(context?.metadata ?? {}),
                            provider: AIProvider.OpenAI,
                            model,
                            status: "completed",
                            requestId: context?.requestId
                        }
                    };
                    return;
                }
            }

            // Some providers/runtimes can close the stream without a terminal done event.
            // Emit best-effort terminal chunk so job lifecycle can complete deterministically.
            const fallbackMessage = this.createAssistantTextMessage({
                id: responseId,
                text: accumulatedText,
                model,
                status: "completed",
                requestContext: context
            });

            yield {
                done: true,
                id: responseId,
                output: [fallbackMessage],
                multimodalArtifacts: { chat: [fallbackMessage] },
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

            // Stream error contract: terminal chunk with empty output and diagnostic metadata.
            yield {
                done: true,
                id: responseId,
                output: [],
                delta: [],
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
     * Extracts transcription text from OpenAI non-streaming transcription response variants.
     *
     * @param response Raw transcription response
     * @returns Extracted transcript text
     * @private
     * @remarks
     * Handles SDK variants: object payload (`{ text }`) or plain string response formats.
     */
    private extractTranscriptionText(response: unknown): string {
        if (typeof response === "string") {
            return response;
        }

        const asAny = response as any;
        if (typeof asAny?.text === "string") {
            return asAny.text;
        }

        return "";
    }

    /**
     * Builds a normalized assistant text message for transcription outputs.
     *
     * @param params Message construction parameters
     * @returns Normalized assistant chat message
     * @private
     */
    private createAssistantTextMessage(params: {
        id: string;
        text: string;
        model: string;
        status: "incomplete" | "completed";
        requestContext?: AIRequest<ClientAudioTranscriptionRequest>["context"];
        raw?: unknown;
    }): NormalizedChatMessage {
        const content: NormalizedTextPart[] = params.text ? [{ type: "text", text: params.text }] : [];

        return {
            id: params.id,
            role: "assistant",
            content,
            metadata: {
                ...(params.requestContext?.metadata ?? {}),
                provider: AIProvider.OpenAI,
                model: params.model,
                finishReason: params.status
            },
            ...(params.raw !== undefined ? { raw: params.raw } : {})
        };
    }

    /**
     * Converts supported audio input source variants to an OpenAI uploadable file object.
     *
     * @param source Input audio source
     * @param filenameHint Optional filename hint
     * @param mimeTypeHint Optional MIME type hint
     * @returns Uploadable file object for OpenAI SDK
     * @throws {Error} If string input is neither a data URL nor local file path
     * @private
     *
     * @remarks
     * Supports browser and Node source types so callers can pass native runtime inputs.
     */
    private async toUploadableAudioFile(
        source: ClientAudioTranscriptionRequest["file"],
        filenameHint?: string,
        mimeTypeHint?: string
    ) {
        if (this.isBlobLike(source)) {
            const fileName = filenameHint ?? "audio-input";
            return await toFile(source as any, fileName, mimeTypeHint ? { type: mimeTypeHint } : undefined);
        }

        if (Buffer.isBuffer(source)) {
            const fileName = filenameHint ?? "audio-input";
            return await toFile(source, fileName, mimeTypeHint ? { type: mimeTypeHint } : undefined);
        }

        if (source instanceof Uint8Array) {
            const fileName = filenameHint ?? "audio-input";
            return await toFile(Buffer.from(source), fileName, mimeTypeHint ? { type: mimeTypeHint } : undefined);
        }

        if (source instanceof ArrayBuffer) {
            const fileName = filenameHint ?? "audio-input";
            return await toFile(Buffer.from(source), fileName, mimeTypeHint ? { type: mimeTypeHint } : undefined);
        }

        if (typeof source === "string") {
            if (source.startsWith("data:")) {
                // Data URL path: decode payload and preserve caller mime override when provided.
                const parsed = this.parseDataUrl(source);
                const fileName = filenameHint ?? "audio-input";
                return await toFile(parsed.bytes, fileName, { type: mimeTypeHint ?? parsed.mimeType });
            }

            if (existsSync(source)) {
                // Local path path: read bytes and infer upload filename from basename.
                const bytes = await readFile(source);
                const fileName = filenameHint ?? this.fileNameFromPath(source);
                return await toFile(bytes, fileName, mimeTypeHint ? { type: mimeTypeHint } : undefined);
            }

            throw new Error("String audio input must be a data URL or local file path");
        }

        const fileName = filenameHint ?? "audio-input";
        // Fallback for stream-like values accepted by OpenAI `toFile`.
        return await toFile(source as any, fileName, mimeTypeHint ? { type: mimeTypeHint } : undefined);
    }

    /**
     * Lightweight runtime check for File/Blob-like objects.
     *
     * @param value Candidate input source
     * @returns True when value has Blob/File-like shape
     * @private
     */
    private isBlobLike(value: unknown): boolean {
        if (!value || typeof value !== "object") {
            return false;
        }
        return typeof (value as any).arrayBuffer === "function" && typeof (value as any).type === "string";
    }

    /**
     * Parses a data URL into bytes and MIME type.
     *
     * @param dataUrl Data URL input
     * @returns Decoded bytes and detected mime type
     * @throws {Error} If data URL is malformed
     * @private
     */
    private parseDataUrl(dataUrl: string): { bytes: Buffer; mimeType: string } {
        const commaIndex = dataUrl.indexOf(",");
        if (commaIndex < 0) {
            throw new Error("Invalid data URL");
        }

        const header = dataUrl.slice(0, commaIndex);
        const payload = dataUrl.slice(commaIndex + 1);
        const mimeMatch = /^data:([^;]+)(;base64)?$/i.exec(header);
        const mimeType = mimeMatch?.[1] ?? "application/octet-stream";

        const isBase64 = /;base64$/i.test(header);
        const bytes = isBase64 ? Buffer.from(payload, "base64") : Buffer.from(decodeURIComponent(payload), "utf8");
        return { bytes, mimeType };
    }

    /**
     * Extracts a filename from a local file path.
     *
     * @param filePath Local file path
     * @returns Basename fallback for uploads
     * @private
     */
    private fileNameFromPath(filePath: string): string {
        const normalized = filePath.replace(/\\/g, "/");
        const name = normalized.split("/").pop();
        return name && name.length > 0 ? name : "audio-input";
    }

    /**
     * Runtime guard for async-iterable stream responses.
     *
     * @param value Candidate stream response
     * @returns True when value implements `Symbol.asyncIterator`
     * @private
     */
    private isAsyncIterable(value: unknown): value is AsyncIterable<any> {
        return typeof (value as any)?.[Symbol.asyncIterator] === "function";
    }
}
