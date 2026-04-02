/**
 * @module providers/openai/capabilities/OpenAIChatCapabilityImpl.ts
 * @description OpenAI chat capability adapter built on the Responses API.
 */
import OpenAI from "openai";
import {
    AIProvider,
    AIRequest,
    AIResponse,
    AIResponseChunk,
    BaseProvider,
    CapabilityKeys,
    ChatCapability,
    ChatStreamCapability,
    ClientChatMessage,
    ClientChatRequest,
    ClientMessagePart,
    MultiModalExecutionContext,
    NormalizedChatMessage,
    resolveReferenceMediaUrl,
    buildMetadata
} from "#root/index.js";

/**
 * OpenAIChatCapabilityImpl: Implements OpenAI Responses API chat functionality.
 *
 * Responsibilities:
 * - Adapt ProviderPlaneAI chat requests to OpenAI Responses API
 * - Normalize responses into AIResponse / AIResponseChunk
 * - Support both streaming and non-streaming chat
 *
 * This capability is stateless with respect to session and turn lifecycle.
 * Continuation, turn management, and multimodal state are owned by AIClient.
 *
 */
export class OpenAIChatCapabilityImpl
    implements
        ChatCapability<ClientChatRequest, NormalizedChatMessage>,
        ChatStreamCapability<ClientChatRequest, NormalizedChatMessage>
{
    /**
     * Creates a new OpenAI chat capability implementation.
     *
     * @param {BaseProvider} provider - Owning provider instance.
     * @param {OpenAI} client - Initialized OpenAI SDK client.
     */
    constructor(
        private readonly provider: BaseProvider,
        private readonly client: OpenAI
    ) {}

    /**
     * Executes a non-streaming chat request using OpenAI Responses API.
     *
     * @param {AIRequest<ClientChatRequest>} request - Unified AI chat request.
     * @param {MultiModalExecutionContext | undefined} _executionContext - Optional execution context.
     * @param {AbortSignal | undefined} signal - Optional abort signal.
     * @returns {Promise<AIResponse<NormalizedChatMessage>>} AIResponse containing the output.
     * @throws {Error} If input messages are missing or the request is aborted.
     */
    async chat(
        request: AIRequest<ClientChatRequest>,
        _executionContext?: MultiModalExecutionContext,
        signal?: AbortSignal
    ): Promise<AIResponse<NormalizedChatMessage>> {
        // Ensure provider has been initialized with credentials + client
        this.provider.ensureInitialized();

        if (signal?.aborted) {
            throw new Error("Request aborted");
        }

        const { input, options, context } = request;
        // Defensive validation: OpenAI requires at least one message
        if (!input?.messages?.length) {
            throw new Error("Received empty input messages");
        }

        // Merge general, provider, model, and request-level options
        const merged = this.provider.getMergedOptions(CapabilityKeys.ChatCapabilityKey, options);

        // Call OpenAI Responses API with chat messages
        const response: OpenAI.Responses.Response = await this.client.responses.create(
            {
                model: merged.model,
                input: this.buildMessages(input.messages),
                ...(merged.modelParams ?? {}),
                ...(merged.providerParams ?? {})
            },
            { signal }
        );

        const text = this.extractAssistantText(response);

        // Convert raw OpenAI text output into a normalized chat message
        const message = this.textToNormalizedChat(
            text,
            "assistant",
            response.id,
            merged.model,
            response.status,
            response.usage
        );

        // Return normalized response shape expected by callers
        return {
            output: message,
            rawResponse: response,
            id: response.id,
            metadata: buildMetadata(context?.metadata, {
                provider: AIProvider.OpenAI,
                model: merged.model,
                status: response?.status,
                requestId: context?.requestId
            })
        };
    }

    /**
     * Executes a streaming chat request using OpenAI Responses API.
     * Streams incremental response chunks as they are received from OpenAI.
     * Each chunk is wrapped as a `NormalizedChatMessage` for both `delta` (partial)
     * and `output` (accumulated full text). Chunks are emitted in batches to
     * smooth UI updates and reduce downstream backpressure.
     *
     * @param {AIRequest<ClientChatRequest>} request - Unified AI chat request.
     * @param {MultiModalExecutionContext | undefined} _executionContext - Optional execution context.
     * @param {AbortSignal | undefined} signal - Optional abort signal.
     * @returns {AsyncGenerator<AIResponseChunk<NormalizedChatMessage>>} Async iterable emitting normalized chat chunks.
     * @throws {Error} If input messages are missing.
     */
    async *chatStream(
        request: AIRequest<ClientChatRequest>,
        _executionContext?: MultiModalExecutionContext,
        signal?: AbortSignal
    ): AsyncGenerator<AIResponseChunk<NormalizedChatMessage>> {
        // Ensure provider has been initialized
        this.provider.ensureInitialized();

        const { input, options, context } = request;
        // Streaming still requires at least one input message
        if (!input?.messages?.length) {
            throw new Error("Received empty input messages");
        }

        // Merge general, provider, model, and request-level options
        const merged = this.provider.getMergedOptions(CapabilityKeys.ChatStreamCapabilityKey, options);

        /**
         * Controls how many characters are accumulated before
         * emitting a chunk. This smooths UI rendering and reduces
         * downstream backpressure.
         */
        const batchSize = Number(merged?.generalParams?.chatStreamBatchSize ?? 64);

        let responseId: string | undefined;
        let accumulatedText = "";

        try {
            if (signal?.aborted) {
                return;
            }

            // Open a streaming connection for current messages
            const stream = await this.client.responses.stream(
                {
                    model: merged.model,
                    input: this.buildMessages(input.messages),
                    ...(merged.modelParams ?? {}),
                    ...(merged.providerParams ?? {})
                },
                { signal }
            );

            // Buffer partial deltas until we flush
            let buffer = "";

            // Iterate over events from the provider stream
            for await (const event of stream) {
                // Some events carry response metadata (created/completed)
                if (
                    !responseId &&
                    (event.type === "response.created" || event.type === "response.completed") &&
                    "response" in event &&
                    event.response?.id
                ) {
                    responseId = event.response.id;
                }

                // End-of-text for this stream
                if (event.type === "response.output_text.done") {
                    break;
                }

                // Text delta events: accumulate and flush once buffer reaches batchSize
                const deltaText = this.extractAssistantDelta(event);

                if (deltaText) {
                    buffer += deltaText;
                    accumulatedText += deltaText;

                    if (buffer.length >= batchSize) {
                        yield this.createChunk(buffer, accumulatedText, responseId, context, merged.model, "incomplete");
                        buffer = "";
                    }
                }
            }

            // Flush any remaining buffer
            if (buffer.length > 0 || accumulatedText.length > 0) {
                yield this.createChunk(buffer, accumulatedText, responseId, context, merged.model, "incomplete");
            }

            // Final completion chunk
            yield this.createChunk(accumulatedText, accumulatedText, responseId, context, merged.model, "completed", true);
        } catch (err) {
            // Abort is NOT an error — do not emit a terminal chunk
            if (signal?.aborted || (err instanceof Error && err.message === "Stream aborted")) {
                yield this.createChunk("", "", responseId, context, merged.model, "error", true, err);
            }
        }
    }

    /**
     * Helper to build a streaming chunk with proper NormalizedChatMessage
     *
     * @param deltaText Newly received delta text
     * @param accumulatedText Full text accumulated so far
     * @param responseId Response ID
     * @param context Optional request context
     * @param model Model name
     * @param status Chunk status: "incomplete", "completed", "error"
     * @param done Whether this is the final chunk
     * @param error Optional error object if status is "error"
     */
    private createChunk(
        deltaText: string,
        accumulatedText: string,
        responseId: string | undefined,
        context: AIRequest<ClientChatRequest>["context"],
        model: string,
        status: "incomplete" | "completed" | "error",
        done: boolean = false,
        error?: unknown
    ): AIResponseChunk<NormalizedChatMessage> {
        const messageMetadata = buildMetadata(context?.metadata, {
            provider: AIProvider.OpenAI,
            model,
            status,
            requestId: context?.requestId,
            ...(error ? { error } : {})
        });

        const delta: NormalizedChatMessage = {
            id: crypto.randomUUID(),
            role: "assistant",
            content: deltaText ? [{ type: "text", text: deltaText }] : [],
            metadata: messageMetadata
        };
        const output: NormalizedChatMessage = {
            id: responseId ?? crypto.randomUUID(),
            role: "assistant",
            content: accumulatedText ? [{ type: "text", text: accumulatedText }] : [],
            metadata: messageMetadata
        };

        return {
            delta,
            output,
            done,
            id: responseId,
            metadata: messageMetadata
        };
    }

    private textToNormalizedChat(
        text: string,
        role: "assistant" | "user" | "system",
        id?: string,
        model?: string,
        status?: string | null,
        usage?: OpenAI.Responses.ResponseUsage | null
    ): NormalizedChatMessage {
        return {
            id: id ?? crypto.randomUUID(),
            role,
            content: text ? [{ type: "text", text }] : [],
            metadata: buildMetadata(undefined, {
                ...(model ? { model } : {}),
                ...(status ? { status } : {}),
                ...(usage
                    ? {
                          usage: {
                              totalTokens: usage.total_tokens,
                              outputTokens: usage.output_tokens,
                              inputTokens: usage.input_tokens
                          }
                      }
                    : {})
            })
        };
    }

    private extractAssistantText(response: OpenAI.Responses.Response): string {
        if (!response.output) {
            return "";
        }

        let text = "";

        for (const item of response.output) {
            if (item.type !== "message") {
                continue;
            }
            if (item.role !== "assistant") {
                continue;
            }

            for (const content of item.content ?? []) {
                if (content.type === "output_text" && content.text) {
                    text += content.text;
                }
            }
        }

        return text;
    }

    private extractAssistantDelta(event: any): string | null {
        if (event.type !== "response.output_text.delta") {
            return null;
        }
        if (!event.delta) {
            return null;
        }
        return event.delta;
    }

    /**
     * Convert the array of Provider agnostic messages to OpenAI specific ones
     *
     * @param messages Provider agnostic list of messages to send to OpenAI
     * @returns Array of converted messages for OpenAI
     */
    private buildMessages(messages: ClientChatMessage[]): any[] {
        return messages.map((m) => ({
            role: m.role,
            content: this.mapParts(m.content)
        }));
    }

    /**
     * Convert ClientMessageParts to the OpenAI Responses input items.
     *
     * @param parts Message component to convert to OpenAI format
     * @returns Array of converted messages for OpenAI
     */
    private mapParts(parts: ClientMessagePart[] | ClientMessagePart | string): any[] {
        const normalizedParts: ClientMessagePart[] =
            typeof parts === "string" ? [{ type: "text", text: parts }] : Array.isArray(parts) ? parts : [parts];

        return normalizedParts.map((part) => {
            if (part.type !== "text" && !part.url && !part.base64) {
                throw new Error(`${part.type} part must have url or base64`);
            }

            switch (part.type) {
                case "text":
                    return { type: "input_text", text: part.text };
                case "image":
                    return {
                        type: "input_image",
                        image_url: resolveReferenceMediaUrl(part, "image/png", "image part must have url or base64")
                    };
                case "audio":
                    return {
                        type: "input_audio",
                        audio_url: resolveReferenceMediaUrl(part, "audio/mpeg", "audio part must have url or base64")
                    };
                case "video":
                    return {
                        type: "input_video",
                        video_url: resolveReferenceMediaUrl(part, "video/mp4", "video part must have url or base64")
                    };
                case "file":
                    return {
                        type: "input_file",
                        file_url: resolveReferenceMediaUrl(
                            part,
                            "application/octet-stream",
                            "file part must have url or base64"
                        ),
                        filename: part.filename,
                        mime_type: part.mimeType
                    };
                default:
                    throw new Error(`Unsupported message part: ${(part as any).type}`);
            }
        });
    }
}
