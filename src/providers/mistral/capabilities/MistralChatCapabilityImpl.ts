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
    resolveReferenceMediaUrl
} from "#root/index.js";

const DEFAULT_MISTRAL_CHAT_MODEL = "mistral-small-latest";

/**
 * Adapts Mistral chat completions into ProviderPlaneAI's normalized chat response
 * and stream chunk shapes.
 *
 * Supports text and image inputs, batches streamed text deltas using
 * `chatStreamBatchSize`, and emits a terminal error chunk for non-abort
 * streaming failures while keeping Mistral SDK event details local to the adapter.
 *
 * @public
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
     * @param {MultiModalExecutionContext} [_ctx] Optional execution context. Unused directly in this adapter.
     * @param {AbortSignal} [signal] Optional cancellation signal.
     * @throws {Error} When input messages are empty or the request is already aborted.
     * @returns {Promise<AIResponse<NormalizedChatMessage>>} Provider-normalized assistant message response.
     */
    async chat(
        request: AIRequest<ClientChatRequest>,
        _ctx?: MultiModalExecutionContext,
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
        const model = merged.model ?? DEFAULT_MISTRAL_CHAT_MODEL;
        const completionRequest = this.buildChatCompletionRequest(model, input.messages, merged.modelParams);
        // Keep the SDK call narrow: merged model/provider params are the only
        // provider-specific escape hatches that should leak into the request.
        const response = await this.client.chat.complete(completionRequest, { signal, ...(merged.providerParams ?? {}) });

        // Mistral may return either a plain string or typed content chunks;
        // normalize both into the single text surface PPAI expects for chat.
        const text = this.extractMessageText(response.choices?.[0]?.message?.content ?? undefined);
        const id = response.id ?? crypto.randomUUID();
        const metadata = {
            ...(context?.metadata ?? {}),
            provider: AIProvider.Mistral,
            model,
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
     * - emit one terminal error chunk on provider/runtime failures
     *
     * @param {AIRequest<ClientChatRequest>} request Unified streaming chat request envelope.
     * @param {MultiModalExecutionContext} [_ctx] Optional execution context. Unused directly in this adapter.
     * @param {AbortSignal} [signal] Optional cancellation signal.
     * @throws {Error} When input messages are empty.
     * @returns {AsyncGenerator<AIResponseChunk<NormalizedChatMessage>>} Async stream of normalized chat chunks.
     */
    async *chatStream(
        request: AIRequest<ClientChatRequest>,
        _ctx?: MultiModalExecutionContext,
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

        try {
            if (signal?.aborted) {
                return;
            }

            // The SDK exposes a typed async event stream. We still treat event payloads
            // defensively because provider event unions can evolve across SDK releases.
            const stream = await this.client.chat.stream(
                this.buildChatCompletionRequest(model, input.messages, merged.modelParams),
                { signal, ...(merged.providerParams ?? {}) }
            );

            for await (const event of stream as AsyncIterable<CompletionEvent>) {
                if (signal?.aborted) {
                    return;
                }

                // Response id and usage can arrive late in the stream, so keep the
                // latest seen values and attach them to subsequent normalized chunks.
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

            // Emit one terminal completion chunk even when the final provider event
            // only closes the stream and does not carry any additional text.
            yield this.createChunk("", accumulatedText, responseId, context, model, "completed", true, undefined, latestUsage);
        } catch (err) {
            if (signal?.aborted) {
                return;
            }

            // Surface provider/runtime failures as one terminal error chunk so stream
            // consumers do not hang waiting for completion.
            yield this.createChunk("", "", responseId, context, model, "error", true, err, latestUsage);
        }
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
        // Keep the wrapper metadata and the normalized delta/output message metadata aligned.
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
     * Mistral may surface assistant content as either a bare string or a typed
     * chunk array; this helper keeps the normalized chat surface text-only.
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
        // Fast-path simple text-only messages so Mistral receives the compact string form.
        if (parts.length === 1 && parts[0].type === "text") {
            return parts[0].text;
        }

        return parts.map((part) => {
            switch (part.type) {
                case "text":
                    return { type: "text", text: part.text };
                case "image":
                    // Mistral accepts either remote URLs or data URIs for multimodal chat inputs.
                    return {
                        type: "image_url",
                        imageUrl: resolveReferenceMediaUrl(part, "image/png", "image part must have url or base64")
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
     * @returns {string | Array<Extract<ContentChunk, { type: "text" }>>} SDK-compatible system content payload.
     */
    private buildSystemContent(parts: ClientMessagePart[]): string | Array<Extract<ContentChunk, { type: "text" }>> {
        // Use the compact string form when the system prompt is plain text.
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
     * Builds a Mistral chat request for both non-streaming and streaming chat calls.
     *
     * @param {string} model Resolved model name.
     * @param {ClientChatMessage[]} messages Provider-agnostic chat messages.
     * @param {Record<string, unknown> | undefined} modelParams Provider/model-specific request overrides.
     * @returns {ChatCompletionRequest | ChatCompletionStreamRequest} SDK-compatible chat completion request.
     */
    private buildChatCompletionRequest(
        model: string,
        messages: ClientChatMessage[],
        modelParams?: Record<string, unknown>
    ): ChatCompletionRequest | ChatCompletionStreamRequest {
        // Convert ProviderPlane roles into Mistral's narrower role/content union before dispatch.
        const constructedMessages: ChatCompletionRequestMessage[] = messages.map((message) => {
            switch (message.role) {
                case "system":
                    // Mistral uses a narrower system-message shape than user/assistant content,
                    // so we keep the role-specific mapping localized here.
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

        return {
            ...(modelParams ?? {}),
            model,
            messages: constructedMessages
        } as ChatCompletionRequest | ChatCompletionStreamRequest;
    }
}
