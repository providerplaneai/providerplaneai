/**
 * @module providers/mistral/capabilities/MistralChatCapabilityImpl.ts
 * @description Mistral chat capability adapters.
 */
import { Mistral } from "@mistralai/mistralai";
import type {
    AssistantMessage,
    ChatCompletionRequest,
    ChatCompletionRequestMessage,
    ChatCompletionStreamRequest,
    CompletionEvent,
    ContentChunk,
    SystemMessage,
    UserMessage,
    UsageInfo
} from "@mistralai/mistralai/models/components";
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
    ensureDataUri
} from "#root/index.js";

const DEFAULT_MISTRAL_CHAT_MODEL = "mistral-small-latest";

/**
 * MistralChatCapabilityImpl: adapts Mistral chat completions into ProviderPlaneAI's
 * normalized chat response and chunk shapes.
 *
 * Current v1 behavior:
 * - supports text and image input parts
 * - normalizes non-stream and stream responses into `NormalizedChatMessage`
 * - batches stream deltas using `chatStreamBatchSize`
 * - keeps provider-specific SDK event details local to this adapter
 *
 * @public
 * @description Provider capability implementation for MistralChatCapabilityImpl.
 */
export class MistralChatCapabilityImpl
    implements
        ChatCapability<ClientChatRequest, NormalizedChatMessage>,
        ChatStreamCapability<ClientChatRequest, NormalizedChatMessage>
{
    /**
     * Creates a new Mistral chat capability adapter.
     *
     * @param {BaseProvider} provider Owning provider instance used for initialization checks and merged config access.
     * @param {Mistral} client Initialized official Mistral SDK client.
     */
    constructor(
        private readonly provider: BaseProvider,
        private readonly client: Mistral
    ) {}

    /**
     * Executes a non-streaming Mistral chat request.
     *
     * Responsibilities:
     * - validate request inputs
     * - resolve merged model/runtime options
     * - execute `chat.complete` through the official SDK
     * - flatten Mistral content into normalized assistant text
     * - attach provider/model/token metadata for observability
     *
     * @param {AIRequest<ClientChatRequest>} request Unified chat request envelope.
     * @param {MultiModalExecutionContext} [_executionContext] Optional execution context. Unused directly in this adapter.
     * @param {AbortSignal} [signal] Optional cancellation signal.
     * @throws {Error} When input messages are empty or the request is already aborted.
     * @returns {Promise<AIResponse<NormalizedChatMessage>>} Provider-normalized assistant message response.
     */
    async chat(
        request: AIRequest<ClientChatRequest>,
        _executionContext?: MultiModalExecutionContext,
        signal?: AbortSignal
    ): Promise<AIResponse<NormalizedChatMessage>> {
        this.provider.ensureInitialized();

        const { input, options, context } = request;
        if (!input?.messages?.length) {
            throw new Error("Received empty input messages");
        }
        if (signal?.aborted) {
            throw new Error("Request aborted");
        }

        const merged = this.provider.getMergedOptions(CapabilityKeys.ChatCapabilityKey, options);
        // Keep the SDK call narrow: merged model/provider params are the only
        // provider-specific escape hatches that should leak into the request.
        const response = await this.client.chat.complete(
            this.buildChatCompletionRequest(merged.model ?? DEFAULT_MISTRAL_CHAT_MODEL, input.messages, merged.modelParams),
            { signal, ...(merged.providerParams ?? {}) }
        );

        // Mistral may return either a plain string or typed content chunks;
        // normalize both into the single text surface PPAI expects for chat.
        const text = this.extractMessageText(response.choices?.[0]?.message?.content ?? undefined);
        const id = response.id ?? crypto.randomUUID();
        const metadata = {
            ...(context?.metadata ?? {}),
            provider: AIProvider.Mistral,
            model: merged.model ?? response.model ?? DEFAULT_MISTRAL_CHAT_MODEL,
            status: "completed",
            requestId: context?.requestId,
            ...this.extractUsage(response.usage)
        };

        return {
            output: {
                id,
                role: "assistant",
                content: text ? [{ type: "text", text }] : [],
                metadata
            },
            rawResponse: response,
            id,
            metadata
        };
    }

    /**
     * Executes a streaming Mistral chat request.
     *
     * Responsibilities:
     * - execute `chat.stream` through the official SDK
     * - accumulate provider deltas into larger buffered chunks
     * - expose both `delta` and accumulated `output` in normalized chunk form
     * - preserve final token usage when Mistral includes it late in the stream
     *
     * @param {AIRequest<ClientChatRequest>} request Unified streaming chat request envelope.
     * @param {MultiModalExecutionContext} [_executionContext] Optional execution context. Unused directly in this adapter.
     * @param {AbortSignal} [signal] Optional cancellation signal.
     * @throws {Error} When input messages are empty.
     * @returns {AsyncGenerator<AIResponseChunk<NormalizedChatMessage>>} Async stream of normalized chat chunks.
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
        const batchSize = Number(merged?.generalParams?.chatStreamBatchSize ?? 64);
        const model = merged.model ?? DEFAULT_MISTRAL_CHAT_MODEL;

        let responseId: string | undefined;
        let accumulatedText = "";
        let buffer = "";
        let latestUsage: UsageInfo | undefined;

        // The SDK exposes a typed async event stream. We still treat event payloads
        // defensively because provider event unions can evolve across SDK releases.
        const stream = await this.client.chat.stream(
            this.buildChatCompletionStreamRequest(model, input.messages, merged.modelParams),
            { signal, ...(merged.providerParams ?? {}) }
        );

        for await (const event of stream as AsyncIterable<CompletionEvent>) {
            if (signal?.aborted) {
                return;
            }

            responseId ??= event?.data?.id;
            latestUsage = event?.data?.usage ?? latestUsage;
            const deltaText = this.extractMessageText(event?.data?.choices?.[0]?.delta?.content);
            if (!deltaText) {
                continue;
            }

            // Batch small provider deltas into larger updates for smoother downstream rendering.
            buffer += deltaText;
            accumulatedText += deltaText;

            if (buffer.length >= batchSize) {
                yield this.createChunk(
                    buffer,
                    accumulatedText,
                    responseId,
                    context,
                    model,
                    "incomplete",
                    false,
                    undefined,
                    latestUsage
                );
                buffer = "";
            }
        }

        if (buffer.length > 0 || accumulatedText.length > 0) {
            yield this.createChunk(
                buffer,
                accumulatedText,
                responseId,
                context,
                model,
                "incomplete",
                false,
                undefined,
                latestUsage
            );
        }

        yield this.createChunk("", accumulatedText, responseId, context, model, "completed", true, undefined, latestUsage);
    }

    /**
     * Creates one normalized streaming chunk from provider delta state.
     *
     * @param {string} deltaText Newly received text delta.
     * @param {string} accumulatedText Full text accumulated so far.
     * @param {string | undefined} responseId Provider response id when available.
     * @param {AIRequest<ClientChatRequest>["context"]} context Request context metadata.
     * @param {string} model Resolved model name.
     * @param {"incomplete" | "completed" | "error"} status Chunk lifecycle status.
     * @param {boolean} done Whether this is the terminal chunk.
     * @param {unknown} [error] Optional error payload for terminal error chunks.
     * @param {UsageInfo} [usage] Optional provider token-usage payload.
     * @returns {AIResponseChunk<NormalizedChatMessage>} Provider-normalized stream chunk.
     */
    private createChunk(
        deltaText: string,
        accumulatedText: string,
        responseId: string | undefined,
        context: AIRequest<ClientChatRequest>["context"],
        model: string,
        status: "incomplete" | "completed" | "error",
        done: boolean,
        error?: unknown,
        usage?: UsageInfo
    ): AIResponseChunk<NormalizedChatMessage> {
        const metadata = {
            ...(context?.metadata ?? {}),
            provider: AIProvider.Mistral,
            model,
            status,
            requestId: context?.requestId,
            ...this.extractUsage(usage),
            ...(error ? { error } : {})
        };

        return {
            delta: {
                id: crypto.randomUUID(),
                role: "assistant",
                content: deltaText ? [{ type: "text", text: deltaText }] : [],
                metadata
            },
            output: {
                id: responseId ?? crypto.randomUUID(),
                role: "assistant",
                content: accumulatedText ? [{ type: "text", text: accumulatedText }] : [],
                metadata
            },
            done,
            id: responseId,
            metadata
        };
    }

    /**
     * Normalizes token-usage metadata from Mistral SDK payloads.
     *
     * The SDK has used camelCase fields, but raw provider payloads may still
     * expose snake_case in some contexts. This helper tolerates both.
     *
     * @param {UsageInfo} [usage] Raw provider usage object.
     * @returns {{ inputTokens?: number; outputTokens?: number; totalTokens?: number; }} Normalized token counts.
     */
    private extractUsage(usage?: UsageInfo) {
        if (!usage) {
            return {};
        }
        return {
            inputTokens: usage.promptTokens,
            outputTokens: usage.completionTokens,
            totalTokens: usage.totalTokens
        };
    }

    /**
     * Flattens Mistral message content into plain text.
     *
     * @param {string | Array<ContentChunk> | null | undefined} content Provider message content.
     * @returns {string} Flattened text content.
     */
    private extractMessageText(content: string | Array<ContentChunk> | null | undefined): string {
        if (!content) {
            return "";
        }
        if (typeof content === "string") {
            return content;
        }
        return content
            .filter(
                (part): part is Extract<ContentChunk, { type: "text" }> =>
                    part?.type === "text" && "text" in part && typeof part.text === "string"
            )
            .map((part) => part.text)
            .join("");
    }

    /**
     * Converts provider-agnostic client messages into Mistral message payloads.
     *
     * @param {ClientChatMessage[]} messages Provider-agnostic chat messages.
     * @returns {ChatCompletionRequestMessage[]} SDK-compatible Mistral message payloads.
     */
    private buildMessages(messages: ClientChatMessage[]): ChatCompletionRequestMessage[] {
        return messages.map((message) => {
            switch (message.role) {
                case "system":
                    return <SystemMessage>{
                        role: "system",
                        content: this.buildSystemContent(message.content)
                    };
                case "user":
                    return <UserMessage>{
                        role: "user",
                        content: this.buildContent(message.content)
                    };
                case "assistant":
                    return <AssistantMessage & { role: "assistant" }>{
                        role: "assistant",
                        content: this.buildContent(message.content)
                    };
            }
        });
    }

    /**
     * Converts ProviderPlane message parts into Mistral chat content parts.
     *
     * Current v1 support:
     * - `text`
     * - `image`
     *
     * @param {ClientMessagePart[]} parts Provider-agnostic message parts.
     * @throws {Error} When a message part type is unsupported by Mistral v1 in PPAI.
     * @returns {Array<ContentChunk> | string} SDK-compatible content payload.
     */
    private buildContent(parts: ClientMessagePart[]): Array<ContentChunk> | string {
        if (parts.length === 1 && parts[0].type === "text") {
            return parts[0].text;
        }

        return parts.map((part) => {
            switch (part.type) {
                case "text":
                    return { type: "text", text: part.text };
                case "image":
                    // Mistral accepts either remote URLs or data URIs for vision/chat-with-image inputs.
                    return {
                        type: "image_url",
                        imageUrl: part.url ?? ensureDataUri(part.base64 ?? "", part.mimeType)
                    };
                default:
                    throw new Error(`Mistral chat does not support '${part.type}' message parts in v1`);
            }
        });
    }

    /**
     * Converts system-message parts into the narrower content shape allowed by Mistral.
     *
     * Mistral system messages support text/thinking chunks, but PPAI v1 only emits
     * text here to keep the provider surface deterministic.
     *
     * @param {ClientMessagePart[]} parts Provider-agnostic system message parts.
     * @throws {Error} When a non-text system message part is supplied.
     * @returns {string | TextChunk[]} SDK-compatible system content payload.
     */
    private buildSystemContent(parts: ClientMessagePart[]): string | Array<Extract<ContentChunk, { type: "text" }>> {
        if (parts.length === 1 && parts[0].type === "text") {
            return parts[0].text;
        }

        return parts.map((part) => {
            if (part.type !== "text") {
                throw new Error(`Mistral system messages do not support '${part.type}' parts in v1`);
            }
            return { type: "text", text: part.text };
        });
    }

    /**
     * Builds a typed non-streaming chat request for the Mistral SDK.
     *
     * @param {string} model Resolved model name.
     * @param {ClientChatMessage[]} messages Provider-agnostic chat messages.
     * @param {Record<string, unknown> | undefined} modelParams Provider/model-specific request overrides.
     * @returns {ChatCompletionRequest} SDK-compatible chat completion request.
     */
    private buildChatCompletionRequest(
        model: string,
        messages: ClientChatMessage[],
        modelParams?: Record<string, unknown>
    ): ChatCompletionRequest {
        return {
            model,
            messages: this.buildMessages(messages),
            ...(modelParams ?? {})
        } as ChatCompletionRequest;
    }

    /**
     * Builds a typed streaming chat request for the Mistral SDK.
     *
     * @param {string} model Resolved model name.
     * @param {ClientChatMessage[]} messages Provider-agnostic chat messages.
     * @param {Record<string, unknown> | undefined} modelParams Provider/model-specific request overrides.
     * @returns {ChatCompletionStreamRequest} SDK-compatible streaming chat request.
     */
    private buildChatCompletionStreamRequest(
        model: string,
        messages: ClientChatMessage[],
        modelParams?: Record<string, unknown>
    ): ChatCompletionStreamRequest {
        return {
            model,
            messages: this.buildMessages(messages),
            ...(modelParams ?? {})
        } as ChatCompletionStreamRequest;
    }
}
