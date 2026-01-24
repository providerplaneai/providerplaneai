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
    ensureDataUri,
    MultiModalExecutionContext
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
 * @template TChatInput - Client chat request input type
 * @template TChatOutput - Chat output type
 */
export class OpenAIChatCapabilityImpl
    implements ChatCapability<ClientChatRequest, string>, ChatStreamCapability<ClientChatRequest, string>
{
    /**
     * Creates a new OpenAI chat capability implementation.
     *
     * @param provider - Owning provider instance
     * @param client - Initialized OpenAI SDK client
     */
    constructor(
        private readonly provider: BaseProvider,
        private readonly client: OpenAI
    ) {}

    /**
     * Executes a non-streaming chat request using OpenAI Responses API.
     *
     * @template TChatInput Chat input type
     * @param request Unified AI chat request
     * @param _executionContext Optional execution context
     * @returns AIResponse containing the output
     * @throws Error if input messages are missing or provider is uninitialized
     */
    async chat(
        request: AIRequest<ClientChatRequest>,
        _executionContext?: MultiModalExecutionContext
    ): Promise<AIResponse<string>> {
        // Ensure provider has been initialized with credentials + client
        this.provider.ensureInitialized();

        const { input, options, context } = request;
        // Defensive validation: OpenAI requires at least one message
        if (!input?.messages?.length) {
            throw new Error("Received empty input messages");
        }

        // Merge general, provider, model, and request-level options
        const merged = this.provider.getMergedOptions(CapabilityKeys.ChatCapabilityKey, options);

        // Call OpenAI Responses API with chat messages
        const response: OpenAI.Responses.Response = await this.client.responses.create({
            model: merged.model,
            input: this.buildMessages(input.messages),
            ...(merged.modelParams ?? {}),
            ...(merged.providerParams ?? {})
        });

        // Return normalized response shape expected by callers
        return {
            output: response.output_text ?? "",
            rawResponse: response,
            id: response.id,
            metadata: {
                provider: AIProvider.OpenAI,
                model: merged.model,
                status: response?.status,
                tokensUsed: response?.usage?.total_tokens,
                requestId: context?.requestId
            }
        };
    }

    /**
     * Executes a streaming chat request using OpenAI Responses API.
     * Emits incremental response chunks as they are received.
     *
     * @param request Unified AI chat request
     * @param _executionContext Optional execution context
     * @returns Async iterable emitting AIResponseChunk objects
     * @throws Error if input messages are missing or provider is uninitialized
     */
    async *chatStream(
        request: AIRequest<ClientChatRequest>,
        _executionContext?: MultiModalExecutionContext
    ): AsyncGenerator<AIResponseChunk<string>> {
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
            // Open a streaming connection for current messages
            const stream = await this.client.responses.stream({
                model: merged.model,
                input: this.buildMessages(input.messages),
                ...(merged.modelParams ?? {}),
                ...(merged.providerParams ?? {})
            });

            // Buffer partial deltas until we flush
            let buffer = "";

            // Iterate over events from the provider stream
            for await (const event of stream) {
                // End-of-text for this stream
                if (event.type === "response.output_text.done") {
                    break;
                }

                // Some events carry response metadata (created/completed)
                if (
                    !responseId &&
                    (event.type === "response.created" || event.type === "response.completed") &&
                    "response" in event &&
                    event.response?.id
                ) {
                    responseId = event.response.id;
                }

                // Text delta events: accumulate and flush once buffer reaches batchSize
                if (event.type === "response.output_text.delta") {
                    const text: string | undefined = event.delta;
                    if (!text) {
                        continue;
                    }

                    accumulatedText += text;
                    buffer += text;

                    if (buffer.length >= batchSize) {
                        yield {
                            delta: buffer,
                            output: buffer,
                            done: false,
                            id: responseId,
                            metadata: {
                                provider: AIProvider.OpenAI,
                                model: merged.model,
                                status: "incomplete",
                                requestId: context?.requestId
                            }
                        };
                        buffer = "";
                    }
                }
            }

            // Flush any leftover buffer
            if (buffer.length > 0) {
                yield {
                    delta: buffer,
                    output: buffer,
                    done: false,
                    id: responseId,
                    metadata: {
                        provider: AIProvider.OpenAI,
                        model: merged.model,
                        status: "incomplete",
                        requestId: context?.requestId
                    }
                };
            }

            // Final chunk indicating completion
            yield {
                delta: "",
                output: accumulatedText,
                done: true,
                id: responseId,
                metadata: {
                    provider: AIProvider.OpenAI,
                    model: merged.model,
                    status: "completed",
                    requestId: context?.requestId
                }
            };
        } catch (err) {
            yield {
                delta: "",
                output: "",
                done: true,
                id: responseId,
                metadata: {
                    provider: AIProvider.OpenAI,
                    model: merged.model,
                    status: "error",
                    error: err instanceof Error ? err.message : String(err),
                    requestId: context?.requestId
                }
            };
        }
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
    private mapParts(parts: ClientMessagePart[]): any[] {
        return parts.map((part) => {
            if (part.type !== "text" && !part.url && !part.base64) {
                throw new Error(`${part.type} part must have url or base64`);
            }

            switch (part.type) {
                case "text": {
                    return {
                        type: "input_text",
                        text: part.text
                    };
                }

                case "image": {
                    return {
                        type: "input_image",
                        image_url: part.url ?? ensureDataUri(part.base64!, part.mimeType)
                    };
                }

                case "audio": {
                    return {
                        type: "input_audio",
                        audio_url: part.url ?? ensureDataUri(part.base64!, part.mimeType)
                    };
                }

                case "video": {
                    return {
                        type: "input_video",
                        video_url: part.url ?? ensureDataUri(part.base64!, part.mimeType)
                    };
                }

                case "file": {
                    return {
                        type: "input_file",
                        file_url: part.url ?? ensureDataUri(part.base64!, part.mimeType),
                        filename: part.filename,
                        mime_type: part.mimeType
                    };
                }

                default: {
                    throw new Error(`Unsupported message part: ${(part as any).type}`);
                }
            }
        });
    }
}
