/**
 * @module providers/openai/capabilities/OpenAIAudioTranscriptionCapabilityImpl.ts
 * @description OpenAI audio transcription capability adapter.
 */
import OpenAI from "openai";
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
    NormalizedTextPart,
    buildMetadata,
    toOpenAIUploadableFile
} from "#root/index.js";

const DEFAULT_OPENAI_AUDIO_TRANSCRIPTION_MODEL = "gpt-4o-transcribe";

/**
 * Adapts OpenAI audio transcription responses into ProviderPlaneAI's normalized chat artifact surface.
 *
 * Uses the dedicated Audio Transcriptions endpoint (`/v1/audio/transcriptions`)
 * for both non-streaming and streaming transcription flows.
 *
 * @public
 */
export class OpenAIAudioTranscriptionCapabilityImpl
    implements
        AudioTranscriptionCapability<ClientAudioTranscriptionRequest>,
        AudioTranscriptionStreamCapability<ClientAudioTranscriptionRequest>
{
    /**
     * Creates a new OpenAI audio transcription capability adapter.
     *
     * @param {BaseProvider} provider Owning provider instance used for initialization checks and merged config access.
     * @param {OpenAI} client Initialized OpenAI SDK client.
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
     * @param {AIRequest<ClientAudioTranscriptionRequest>} request Unified transcription request envelope.
     * @param {MultiModalExecutionContext} _ctx Optional multimodal execution context. Unused directly in this adapter.
     * @param {AbortSignal} [signal] Optional cancellation signal.
     * @returns {Promise<AIResponse<NormalizedChatMessage[]>>} Provider-normalized transcription artifacts.
     * @throws {Error} If input is invalid, request is aborted, or upload conversion fails.
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
        const uploadFile = await toOpenAIUploadableFile(
            input.file,
            input.filename,
            input.mimeType,
            "audio-input",
            "String audio input must be a data URL or local file path"
        );
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
            metadata: buildMetadata(context?.metadata, {
                provider: AIProvider.OpenAI,
                model,
                status: "completed",
                requestId: context?.requestId
            })
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
     * @param {AIRequest<ClientAudioTranscriptionRequest>} request Unified transcription request envelope.
     * @param {MultiModalExecutionContext} _ctx Optional multimodal execution context. Unused directly in this adapter.
     * @param {AbortSignal} [signal] Optional cancellation signal.
     * @returns {AsyncGenerator<AIResponseChunk<NormalizedChatMessage[]>>} Async generator of transcription delta and completion chunks.
     * @throws {Error} If input is invalid or streaming response shape is unexpected.
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

            const uploadFile = await toOpenAIUploadableFile(
                input.file,
                input.filename,
                input.mimeType,
                "audio-input",
                "String audio input must be a data URL or local file path"
            );
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
                        metadata: buildMetadata(context?.metadata, {
                            provider: AIProvider.OpenAI,
                            model,
                            status: "incomplete",
                            requestId: context?.requestId
                        })
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
                        metadata: buildMetadata(context?.metadata, {
                            provider: AIProvider.OpenAI,
                            model,
                            status: "completed",
                            requestId: context?.requestId
                        })
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
                metadata: buildMetadata(context?.metadata, {
                    provider: AIProvider.OpenAI,
                    model,
                    status: "completed",
                    requestId: context?.requestId
                })
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
                metadata: buildMetadata(context?.metadata, {
                    provider: AIProvider.OpenAI,
                    model,
                    status: "error",
                    requestId: context?.requestId,
                    error: err instanceof Error ? err.message : String(err)
                })
            };
        }
    }

    /**
     * Extracts transcription text from OpenAI non-streaming transcription response variants.
     *
     * @param {unknown} response Raw transcription response.
     * @returns {string} Extracted transcript text.
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
     * @param {{
     *   id: string;
     *   text: string;
     *   model: string;
     *   status: "incomplete" | "completed";
     *   requestContext?: AIRequest<ClientAudioTranscriptionRequest>["context"];
     *   raw?: unknown;
     * }} params Message construction parameters.
     * @returns {NormalizedChatMessage} Normalized assistant transcript message.
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
            metadata: buildMetadata(params.requestContext?.metadata, {
                provider: AIProvider.OpenAI,
                model: params.model,
                finishReason: params.status
            }),
            ...(params.raw !== undefined ? { raw: params.raw } : {})
        };
    }

    /**
     * Runtime guard for async-iterable stream responses.
     *
     * @param {unknown} value Candidate stream response.
     * @returns {value is AsyncIterable<unknown>} True when value implements `Symbol.asyncIterator`.
     * @private
     */
    private isAsyncIterable(value: unknown): value is AsyncIterable<any> {
        return typeof (value as any)?.[Symbol.asyncIterator] === "function";
    }
}
