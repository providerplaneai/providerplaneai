/**
 * @module providers/gemini/capabilities/GeminiChatCapabilityImpl.ts
 * @description Gemini chat capability adapter built on multimodal content generation.
 */
import { GoogleGenAI } from "@google/genai";
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
    resolveReferenceMediaSource,
    buildMetadata
} from "#root/index.js";

const DEFAULT_GEMINI_CHAT_MODEL = "gemini-2.5-flash-latest";

/**
 * @public
 * Gemini chat capability implementation.
 */
export class GeminiChatCapabilityImpl implements ChatCapability<ClientChatRequest>, ChatStreamCapability<ClientChatRequest> {
    /**
     * @param {BaseProvider} provider - Parent provider instance.
     * @param {GoogleGenAI} client - Initialized GoogleGenAI client.
     */
    constructor(
        private readonly provider: BaseProvider,
        private readonly client: GoogleGenAI
    ) {}

    /**
     * Executes a non-streaming Gemini chat request.
     *
     * @param {AIRequest<ClientChatRequest>} request - Unified chat request.
     * @param {MultiModalExecutionContext | undefined} _executionContext - Optional execution context.
     * @param {AbortSignal | undefined} _signal - Optional abort signal.
     * @returns {Promise<AIResponse<NormalizedChatMessage>>} Provider-normalized chat response.
     */
    async chat(
        request: AIRequest<ClientChatRequest>,
        _executionContext?: MultiModalExecutionContext,
        _signal?: AbortSignal
    ): Promise<AIResponse<NormalizedChatMessage>> {
        this.provider.ensureInitialized();

        const { input, options, context } = request;

        if (!input?.messages?.length) {
            throw new Error("Received empty input messages");
        }

        const merged = this.provider.getMergedOptions(CapabilityKeys.ChatCapabilityKey, options);

        const response = await this.client.models.generateContent({
            model: (merged.model ?? DEFAULT_GEMINI_CHAT_MODEL).replace(/^models\//, ""),
            contents: this.buildContents(input.messages),
            ...(merged.modelParams ?? {}),
            ...(merged.providerParams ?? {})
        });

        const text = response?.text ?? "";
        const id = response?.responseId ?? crypto.randomUUID();
        const usage = this.extractUsage(response);

        const message: NormalizedChatMessage = {
            id,
            role: "assistant",
            content: text ? [{ type: "text", text }] : []
        };

        return {
            output: message,
            rawResponse: response,
            id,
            metadata: buildMetadata(context?.metadata, {
                provider: AIProvider.Gemini,
                model: merged.model,
                status: "completed",
                requestId: context?.requestId,
                ...usage
            })
        };
    }

    /**
     * Executes a streaming Gemini chat request.
     *
     * @param {AIRequest<ClientChatRequest>} request - Unified chat request.
     * @param {MultiModalExecutionContext | undefined} _executionContext - Optional execution context.
     * @param {AbortSignal | undefined} signal - Optional abort signal.
     * @returns {AsyncGenerator<AIResponseChunk<NormalizedChatMessage>>} Async generator of normalized chat chunks.
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

        let responseId: string | undefined;
        let accumulatedText = "";
        let buffer = "";
        let latestUsage: ReturnType<GeminiChatCapabilityImpl["extractUsage"]> | undefined;

        try {
            const stream = await this.client.models.generateContentStream({
                model: (merged.model ?? DEFAULT_GEMINI_CHAT_MODEL).replace(/^models\//, ""),
                contents: this.buildContents(input.messages),
                ...(merged.modelParams ?? {}),
                ...(merged.providerParams ?? {})
            });

            for await (const chunk of stream) {
                if (signal?.aborted) {
                    return;
                }
                latestUsage = this.extractUsage(chunk);

                const deltaText = chunk.text ?? "";
                if (!deltaText) {
                    continue;
                }

                // Set responseId once
                if (!responseId && chunk.responseId) {
                    responseId = chunk.responseId;
                }

                buffer += deltaText;
                accumulatedText += deltaText;

                if (buffer.length >= batchSize) {
                    yield this.createChunk(
                        buffer,
                        accumulatedText,
                        responseId,
                        context,
                        merged.model,
                        "incomplete",
                        false,
                        undefined,
                        latestUsage
                    );
                    buffer = "";
                }
            }

            // Flush any remaining buffer
            if (buffer.length > 0 || accumulatedText.length > 0) {
                yield this.createChunk(
                    buffer,
                    accumulatedText,
                    responseId,
                    context,
                    merged.model,
                    "incomplete",
                    false,
                    undefined,
                    latestUsage
                );
            }

            // Final completion chunk
            yield this.createChunk(
                accumulatedText,
                accumulatedText,
                responseId,
                context,
                merged.model,
                "completed",
                true,
                undefined,
                latestUsage
            );
        } catch (err) {
            if (signal?.aborted) {
                return;
            }

            yield this.createChunk("", "", responseId, context, merged.model, "error", true, err, latestUsage);
        }
    }

    /**
     * Builds a normalized Gemini streaming chunk.
     *
     * @param {string} deltaText - Newly received text delta.
     * @param {string} accumulatedText - Full assistant text accumulated so far.
     * @param {string | undefined} responseId - Provider response identifier when available.
     * @param {AIRequest<ClientChatRequest>["context"]} context - Request context.
     * @param {string} model - Resolved model name.
     * @param {"incomplete" | "completed" | "error"} status - Chunk status.
     * @param {boolean} done - Whether this is the terminal chunk.
     * @param {unknown} error - Optional terminal error payload.
     * @param {ReturnType<GeminiChatCapabilityImpl["extractUsage"]> | undefined} usage - Optional usage payload.
     * @returns {AIResponseChunk<NormalizedChatMessage>} Normalized streaming chunk.
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
        usage?: ReturnType<GeminiChatCapabilityImpl["extractUsage"]>
    ): AIResponseChunk<NormalizedChatMessage> {
        const messageMetadata = buildMetadata(context?.metadata, {
            provider: AIProvider.Gemini,
            model,
            status,
            requestId: context?.requestId,
            ...(usage ?? {}),
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

    private extractUsage(response: any): {
        inputTokens?: number;
        outputTokens?: number;
        totalTokens?: number;
    } {
        const usage = response?.usageMetadata;
        if (!usage) {
            return {};
        }
        return {
            inputTokens: usage.promptTokenCount,
            outputTokens: usage.candidatesTokenCount,
            totalTokens: usage.totalTokenCount
        };
    }

    /**
     * Converts Provider-agnostic ClientChatMessage array into Gemini contents array.
     * Supports text, image, audio, video, and file parts.
     *
     * @param messages Array of ClientChatMessage
     * @returns Array of objects ready for Gemini API
     */
    private buildContents(messages: ClientChatMessage[]): any[] {
        const contents: any[] = [];

        for (const msg of messages) {
            for (const part of msg.content) {
                switch (part.type) {
                    case "text":
                        contents.push({ type: "text", text: part.text });
                        break;
                    case "image":
                        contents.push(this.buildMediaPart(part, "image/png"));
                        break;
                    case "audio":
                        contents.push(this.buildMediaPart(part, "audio/mpeg"));
                        break;
                    case "video":
                        contents.push(this.buildMediaPart(part, "video/mp4"));
                        break;
                    case "file":
                        contents.push(this.buildMediaPart(part, "application/octet-stream"));
                        break;
                    default:
                        throw new Error(`Unsupported Gemini chat part: ${part}`);
                }
            }
        }

        return contents;
    }

    /**
     * Normalizes Gemini media parts so only one source form is forwarded.
     *
     * Gemini chat keeps its provider-specific `*_url` / `*_base64` request shape,
     * but shared source normalization still strips Data URI wrappers from base64
     * inputs and enforces the same non-empty source contract used elsewhere.
     */
    private buildMediaPart(
        part: Exclude<ClientMessagePart, string | { type: "text"; text: string }>,
        defaultMimeType: string
    ): Record<string, unknown> {
        if (part.url) {
            switch (part.type) {
                case "image":
                    return { type: "image", image_url: part.url, caption: part.caption };
                case "audio":
                    return { type: "audio", audio_url: part.url, mime_type: part.mimeType };
                case "video":
                    return { type: "video", video_url: part.url, mime_type: part.mimeType };
                case "file":
                    return { type: "file", file_url: part.url, filename: part.filename, mime_type: part.mimeType };
            }
        }

        const resolved = resolveReferenceMediaSource(part, defaultMimeType, `${part.type} part must have url or base64`);
        if (resolved.kind !== "base64") {
            throw new Error(`${part.type} part must have url or base64`);
        }

        switch (part.type) {
            case "image":
                return { type: "image", image_base64: resolved.base64, caption: part.caption };
            case "audio":
                return { type: "audio", audio_base64: resolved.base64, mime_type: resolved.mimeType };
            case "video":
                return { type: "video", video_base64: resolved.base64, mime_type: resolved.mimeType };
            case "file":
                return { type: "file", file_base64: resolved.base64, filename: part.filename, mime_type: resolved.mimeType };
            default:
                throw new Error(`Unsupported Gemini chat part: ${part}`);
        }
    }
}
