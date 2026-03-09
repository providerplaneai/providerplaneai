/**
 * @module providers/anthropic/capabilities/AnthropicChatCapabilityImpl.ts
 * @description Provider implementations and capability adapters.
 */
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
    MultiModalExecutionContext,
    NormalizedChatMessage
} from "#root/index.js";

/**
 * Anthropic chat capability implementation.
 *
 * This adapter maps Anthropic message APIs into ProviderPlaneAI's normalized chat
 * response and chunk shapes, while keeping provider-specific event details local.
 *
 * Current behavior:
 * - Text-only chat parts are supported.
 * - Non-stream and stream paths both expose normalized usage metadata when available.
 */
/**
 * @public
 * @description Provider capability implementation for AnthropicChatCapabilityImpl.
 */
export class AnthropicChatCapabilityImpl
    implements
        ChatCapability<ClientChatRequest, NormalizedChatMessage>,
        ChatStreamCapability<ClientChatRequest, NormalizedChatMessage>
{
    /**
     * @param provider Owning provider instance (initialization + config access)
     * @param client Initialized Anthropic SDK client
     */
    constructor(
        private readonly provider: BaseProvider,
        private readonly client: Anthropic
    ) {}

    /**
     * Executes a non-streaming Anthropic chat request.
     *
     * @param request Unified chat request
     * @param _executionContext Optional execution context (unused)
     * @param signal Optional abort signal
     * @returns Normalized single assistant message response
     */
    async chat(
        request: AIRequest<ClientChatRequest>,
        _executionContext?: MultiModalExecutionContext,
        signal?: AbortSignal
    ): Promise<AIResponse<NormalizedChatMessage>> {
        this.provider.ensureInitialized();

        if (signal?.aborted) {
            throw new Error("Request aborted");
        }

        const { input, options, context } = request;

        if (!input?.messages?.length) {
            throw new Error("Received empty input messages");
        }

        const merged = this.provider.getMergedOptions(CapabilityKeys.ChatCapabilityKey, options);

        // Use the same max_tokens default as the stream path for consistent behavior.
        const response = await this.client.messages.create(
            {
                model: merged.model,
                max_tokens: merged.modelParams?.max_tokens ?? 1024,
                messages: this.buildMessages(input.messages),
                ...(merged.modelParams ?? {}),
                ...(merged.providerParams ?? {})
            },
            { signal }
        );

        const text = this.extractText(response);

        const message: NormalizedChatMessage = {
            id: response.id,
            role: "assistant",
            content: text ? [{ type: "text", text }] : [],
            metadata: {
                model: merged.model,
                status: this.normalizeAnthropicStatus(response.stop_reason)
            }
        };

        return {
            output: message,
            rawResponse: response,
            id: response.id,
            metadata: {
                ...(context?.metadata ?? {}),
                provider: AIProvider.Anthropic,
                model: merged.model,
                status: message.metadata?.status as string,
                requestId: context?.requestId,
                ...this.extractUsage(response?.usage)
            }
        };
    }

    /**
     * Executes a streaming Anthropic chat request.
     *
     * Chunks are buffered and emitted in batches (`chatStreamBatchSize`) to
     * reduce chunk churn for downstream consumers.
     *
     * @param request Unified chat request
     * @param _executionContext Optional execution context (unused)
     * @param signal Optional abort signal
     * @returns Async stream of normalized chat chunks
     */
    async *chatStream(
        request: AIRequest<ClientChatRequest>,
        _executionContext?: MultiModalExecutionContext,
        signal?: AbortSignal
    ): AsyncGenerator<AIResponseChunk<NormalizedChatMessage>> {
        this.provider.ensureInitialized();

        const { input, options, context } = request;

        if (!input?.messages?.length) {
            throw new Error("Received empty input messages");
        }

        const merged = this.provider.getMergedOptions(CapabilityKeys.ChatStreamCapabilityKey, options);

        // Batch small provider deltas into larger chunks for smoother UI updates.
        const batchSize = Number(merged?.generalParams?.chatStreamBatchSize ?? 64);

        let responseId: string | undefined;
        let accumulatedText = "";
        let buffer = "";

        try {
            const stream = this.client.messages.stream(
                {
                    model: merged.model,
                    max_tokens: merged.modelParams?.max_tokens ?? 1024,
                    messages: this.buildMessages(input.messages),
                    ...(merged.modelParams ?? {}),
                    ...(merged.providerParams ?? {})
                },
                { signal }
            );

            for await (const event of stream) {
                if (signal?.aborted) {
                    return;
                }

                // Capture provider response id as soon as it is available.
                if (event.type === "message_start") {
                    responseId ??= event.message?.id;
                }

                if (event.type === "content_block_delta" && event.delta?.type === "text_delta") {
                    const text = event.delta.text;
                    accumulatedText += text;
                    buffer += text;

                    // Flush buffer once threshold is reached.
                    if (buffer.length >= batchSize) {
                        yield this.createChunk(buffer, accumulatedText, responseId, context, merged.model, "incomplete");
                        buffer = "";
                    }
                }
            }

            // Flush any remaining buffered text at stream end.
            if (buffer.length > 0) {
                yield this.createChunk(buffer, accumulatedText, responseId, context, merged.model, "incomplete");
            }

            let finalUsage: Anthropic.Messages.Usage | undefined;
            try {
                const final = await stream.finalMessage();
                finalUsage = final?.usage;
            } catch {
                // Usage retrieval failure should not fail the stream after content was emitted.
            }

            yield this.createChunk(
                "",
                accumulatedText,
                responseId,
                context,
                merged.model,
                "completed",
                true,
                undefined,
                finalUsage
            );
        } catch (err) {
            // Intentionally preserves existing behavior:
            // emit an error chunk only for abort/explicit stream-aborted conditions.
            if (signal?.aborted || (err instanceof Error && err.message === "Stream aborted")) {
                yield this.createChunk("", "", responseId, context, merged.model, "error", true, err);
            }
        }
    }

    /**
     * Builds one normalized stream chunk.
     *
     * @param deltaText Newly received text delta
     * @param accumulatedText Full assistant text accumulated so far
     * @param responseId Provider response id when available
     * @param context Request context
     * @param model Resolved model name
     * @param status Chunk status
     * @param done Whether this is the terminal chunk
     * @param error Optional terminal error payload
     * @param usage Optional Anthropic usage payload
     * @returns Normalized chunk with delta, output, and metadata
     */
    private createChunk(
        deltaText: string,
        accumulatedText: string,
        responseId: string | undefined,
        context: AIRequest<ClientChatRequest>["context"],
        model: string,
        status: "incomplete" | "completed" | "error",
        done: boolean = false,
        error?: unknown,
        usage?: Anthropic.Messages.Usage
    ): AIResponseChunk<NormalizedChatMessage> {
        // Shared metadata shape for both chunk message payloads and top-level chunk metadata.
        const messageMetadata = {
            ...(context?.metadata ?? {}),
            provider: AIProvider.Anthropic,
            model,
            status,
            requestId: context?.requestId,
            ...this.extractUsage(usage),
            ...(error ? { error } : {})
        };

        const delta: NormalizedChatMessage = {
            id: responseId ?? crypto.randomUUID(),
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
            metadata: {
                ...(context?.metadata ?? {}),
                provider: AIProvider.Anthropic,
                model,
                status,
                requestId: context?.requestId
            }
        };
    }

    /**
     * Extracts normalized usage fields from Anthropic usage payload.
     *
     * @param usage Anthropic usage object
     * @returns Normalized token counts
     */
    private extractUsage(usage?: Anthropic.Messages.Usage): {
        inputTokens?: number;
        outputTokens?: number;
        totalTokens?: number;
    } {
        if (!usage) {
            return {};
        }

        const inputTokens = usage.input_tokens;
        const outputTokens = usage.output_tokens;
        return {
            inputTokens,
            outputTokens,
            totalTokens: (inputTokens ?? 0) + (outputTokens ?? 0)
        };
    }

    /**
     * Extracts concatenated assistant text from Anthropic message content blocks.
     *
     * @param message Raw Anthropic message
     * @returns Concatenated text content
     */
    private extractText(message: any): string {
        return (message?.content ?? [])
            .filter((c: any) => c.type === "text")
            .map((c: any) => c.text)
            .join("");
    }

    /**
     * Maps provider-agnostic client messages into Anthropic message format.
     *
     * @param messages Client chat messages
     * @returns Anthropic message array
     */
    private buildMessages(messages: ClientChatMessage[]): any[] {
        return messages.map((m) => ({
            role: m.role,
            content: this.mapParts(m.content)
        }));
    }

    /**
     * Maps chat parts to Anthropic content blocks.
     *
     * Current contract is text-only for Anthropic chat in this implementation.
     *
     * @param parts Client message parts
     * @returns Anthropic content blocks
     */
    private mapParts(parts: ClientMessagePart[]): any[] {
        return parts.map((part) => {
            if (part.type !== "text") {
                throw new Error(`Anthropic chat only supports text parts (got ${part.type})`);
            }
            return { type: "text", text: part.text };
        });
    }

    /**
     * Normalizes Anthropic stop reasons into provider-agnostic completion status.
     *
     * @param stopReason Anthropic stop reason
     * @returns `incomplete` when generation was truncated/paused, else `completed`
     */
    private normalizeAnthropicStatus(stopReason: Anthropic.Messages.StopReason | null | undefined): "completed" | "incomplete" {
        switch (stopReason) {
            case "max_tokens":
            case "pause_turn":
                return "incomplete";
            default:
                return "completed";
        }
    }
}
