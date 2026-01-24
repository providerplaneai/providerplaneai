import Anthropic from "@anthropic-ai/sdk";
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
    MultiModalExecutionContext
} from "#root/index.js";

/**
 * AnthropicChatCapabilityImpl: Implements Anthropic (Claude) chat functionality using the Messages API.
 *
 * Responsibilities:
 * - Adapt ProviderPlaneAI chat requests to Anthropic Messages API
 * - Normalize responses into AIResponse / AIResponseChunk
 * - Support both streaming and non-streaming chat
 */
export class AnthropicChatCapabilityImpl implements ChatCapability<ClientChatRequest>, ChatStreamCapability<ClientChatRequest> {
    /**
     * Creates a new Anthropic chat capability implementation.
     *
     * @param provider - Owning provider instance
     * @param client - Initialized Anthropic SDK client
     */
    constructor(
        private readonly provider: BaseProvider,
        private readonly client: Anthropic
    ) {}

    /**
     * Executes a non-streaming chat request using Anthropic Messages API.
     *
     * @param request - Unified AI chat request
     * @param _executionContext Optional execution context
     * @returns AIResponse containing the combined assistant output
     * @throws Error if input messages are missing or provider is uninitialized
     */
    async chat(
        request: AIRequest<ClientChatRequest>,
        _executionContext?: MultiModalExecutionContext
    ): Promise<AIResponse<string>> {
        // Ensure provider has been initialized with credentials + client
        this.provider.ensureInitialized();

        const { input, options, context } = request;

        // Defensive validation: Anthropic requires at least one message
        if (!input?.messages?.length) {
            throw new Error("Received empty input messages");
        }

        // Merge general, provider, model, and request-level options
        const merged = this.provider.getMergedOptions(CapabilityKeys.ChatCapabilityKey, options);

        const response = await this.client.messages.create({
            model: merged.model,
            max_tokens: merged.modelParams?.max_tokens ?? 1024,
            messages: this.buildMessages(input.messages),
            ...(merged.modelParams ?? {}),
            ...(merged.providerParams ?? {})
        });

        // Extract plain text from Anthropic content blocks
        const text = this.extractText(response);

        // Return a fully normalized response
        return {
            output: text ?? "",
            rawResponse: response,
            id: response.id,
            metadata: {
                provider: AIProvider.Anthropic,
                model: merged.model,
                status: this.normalizeAnthropicStatus(response?.stop_reason),
                tokensUsed: response?.usage?.output_tokens,
                requestId: context?.requestId
            }
        };
    }

    /**
     * Executes a streaming chat request using Anthropic Messages streaming API.
     *
     * @param request - Unified AI chat request
     * @param _executionContext Optional execution context
     * @returns AsyncGenerator emitting AIResponseChunk objects
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
            const stream = this.client.messages.stream({
                model: merged.model,
                max_tokens: merged.modelParams?.max_tokens ?? 1024,
                messages: this.buildMessages(input.messages),
                ...(merged.modelParams ?? {}),
                ...(merged.providerParams ?? {})
            });

            let buffer = "";

            /**
             * Loop consumes streaming events from Anthropic.
             * We accumulate text deltas and emit them in batches.
             */
            for await (const event of stream) {
                if (event.type === "message_start") {
                    responseId ??= event.message?.id;
                }

                // yeild on each delta
                if (event.type === "content_block_delta" && event.delta?.type === "text_delta") {
                    const text = event.delta.text;
                    accumulatedText += text;
                    buffer += text;

                    if (buffer.length >= batchSize) {
                        yield {
                            delta: buffer,
                            output: buffer,
                            done: false,
                            id: responseId,
                            metadata: {
                                provider: AIProvider.Anthropic,
                                model: merged.model,
                                status: "incomplete",
                                requestId: context?.requestId
                            }
                        };
                        buffer = "";
                    }
                }
            }

            // Flush any remaining buffered text
            if (buffer.length > 0) {
                yield {
                    delta: buffer,
                    output: buffer,
                    done: false,
                    id: responseId,
                    metadata: {
                        provider: AIProvider.Anthropic,
                        model: merged.model,
                        status: "incomplete",
                        requestId: context?.requestId
                    }
                };
            }

            const final = await stream.finalMessage();
            const stopReason = final?.stop_reason ?? null;

            // Final chunk indicating completion
            yield {
                delta: "",
                output: accumulatedText,
                done: true,
                id: responseId,
                metadata: {
                    provider: AIProvider.Anthropic,
                    model: merged.model,
                    status: this.normalizeAnthropicStatus(stopReason),
                    requestId: context?.requestId
                }
            };
        } catch (err) {
            // Terminal error chunk ensures stream consumers can close cleanly
            yield {
                delta: "",
                output: "",
                done: true,
                id: responseId,
                metadata: {
                    provider: AIProvider.Anthropic,
                    model: merged.model,
                    status: "error",
                    error: err instanceof Error ? err.message : String(err),
                    requestId: context?.requestId
                }
            };
        }
    }

    /**
     * Extracts concatenated text content from an Anthropic message response.
     *
     * @param message - Raw Anthropic message response
     * @returns Concatenated text output
     */
    private extractText(message: any): string {
        return (message?.content ?? [])
            .filter((c: any) => c.type === "text")
            .map((c: any) => c.text)
            .join("");
    }

    /**
     * Converts internal chat messages into Anthropic Messages API format.
     *
     * @param messages - Client chat messages
     * @returns Anthropic-compatible message payload
     */
    private buildMessages(messages: ClientChatMessage[]): any[] {
        return messages.map((m) => ({
            role: m.role,
            content: this.mapParts(m.content)
        }));
    }

    /**
     * Maps client message parts to Anthropic content blocks.
     *
     * @param parts - Message parts
     * @returns Anthropic-compatible content blocks
     * @throws Error if unsupported message part is encountered
     */
    private mapParts(parts: ClientMessagePart[]): any[] {
        return parts.map((part) => {
            switch (part.type) {
                case "text":
                    return { type: "text", text: part.text };
                default:
                    throw new Error(`Unsupported Anthropic chat part: ${part.type}`);
            }
        });
    }

    private normalizeAnthropicStatus(stopReason: Anthropic.Messages.StopReason | null | undefined): string {
        switch (stopReason) {
            case "max_tokens":
            case "pause_turn":
                return "incomplete";

            case "end_turn":
            case "stop_sequence":
            case "tool_use":
            case "refusal":
            case null:
            case undefined:
            default:
                return "completed";
        }
    }
}
