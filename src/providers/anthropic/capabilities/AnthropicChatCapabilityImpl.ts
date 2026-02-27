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
 * AnthropicChatCapabilityImpl
 *
 * Semantic parity with OpenAI chat:
 * - NormalizedChatMessage output
 * - Streaming delta + accumulated output
 */
export class AnthropicChatCapabilityImpl
    implements
        ChatCapability<ClientChatRequest, NormalizedChatMessage>,
        ChatStreamCapability<ClientChatRequest, NormalizedChatMessage>
{
    constructor(
        private readonly provider: BaseProvider,
        private readonly client: Anthropic
    ) {}

    /* ------------------------------------------------------------------ */
    /* Non-streaming chat                                                  */
    /* ------------------------------------------------------------------ */

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

    /* ------------------------------------------------------------------ */
    /* Streaming chat                                                      */
    /* ------------------------------------------------------------------ */

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

                if (event.type === "message_start") {
                    responseId ??= event.message?.id;
                }

                if (event.type === "content_block_delta" && event.delta?.type === "text_delta") {
                    const text = event.delta.text;
                    accumulatedText += text;
                    buffer += text;

                    if (buffer.length >= batchSize) {
                        yield this.createChunk(buffer, accumulatedText, responseId, context, merged.model, "incomplete");
                        buffer = "";
                    }
                }
            }

            if (buffer.length > 0) {
                yield this.createChunk(buffer, accumulatedText, responseId, context, merged.model, "incomplete");
            }

            let finalUsage: Anthropic.Messages.Usage | undefined;
            try {
                const final = await stream.finalMessage();
                finalUsage = final?.usage;
            } catch {
                /* ignored */
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
            // Abort is NOT an error — do not emit a terminal chunk
            if (signal?.aborted || (err instanceof Error && err.message === "Stream aborted")) {
                yield this.createChunk("", "", responseId, context, merged.model, "error", true, err);
            }
        }
    }

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
        // Merge metadata from context + chunk info
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

    private extractText(message: any): string {
        return (message?.content ?? [])
            .filter((c: any) => c.type === "text")
            .map((c: any) => c.text)
            .join("");
    }

    private buildMessages(messages: ClientChatMessage[]): any[] {
        return messages.map((m) => ({
            role: m.role,
            content: this.mapParts(m.content)
        }));
    }

    private mapParts(parts: ClientMessagePart[]): any[] {
        return parts.map((part) => {
            if (part.type !== "text") {
                throw new Error(`Anthropic chat only supports text parts (got ${part.type})`);
            }
            return { type: "text", text: part.text };
        });
    }

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
