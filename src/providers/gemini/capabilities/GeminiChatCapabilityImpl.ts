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
    MultiModalExecutionContext,
    NormalizedChatMessage
} from "#root/index.js";

const DEFAULT_GEMINI_CHAT_MODEL = "gemini-2.5-flash-latest";

export class GeminiChatCapabilityImpl implements ChatCapability<ClientChatRequest>, ChatStreamCapability<ClientChatRequest> {
    constructor(
        private readonly provider: BaseProvider,
        private readonly client: GoogleGenAI
    ) {}

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
            metadata: {
                ...(context?.metadata ?? {}),
                provider: AIProvider.Gemini,
                model: merged.model,
                status: "completed",
                requestId: context?.requestId,
                ...usage
            }
        };
    }

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
     * Helper to build a streaming chunk with proper NormalizedChatMessage and metadata
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
        // Merge metadata from context + chunk info
        const messageMetadata = {
            ...(context?.metadata ?? {}),
            provider: AIProvider.Gemini,
            model,
            status,
            requestId: context?.requestId,
            ...(usage ?? {}),
            ...(error ? { error } : {})
        };

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
                        contents.push({
                            type: "image",
                            image_url: part.url,
                            image_base64: part.base64,
                            caption: part.caption
                        });
                        break;
                    case "audio":
                        contents.push({
                            type: "audio",
                            audio_url: part.url,
                            audio_base64: part.base64,
                            mime_type: part.mimeType
                        });
                        break;
                    case "video":
                        contents.push({
                            type: "video",
                            video_url: part.url,
                            video_base64: part.base64,
                            mime_type: part.mimeType
                        });
                        break;
                    case "file":
                        contents.push({
                            type: "file",
                            file_url: part.url,
                            file_base64: part.base64,
                            filename: part.filename,
                            mime_type: part.mimeType
                        });
                        break;
                    default:
                        throw new Error(`Unsupported Gemini chat part: ${part}`);
                }
            }
        }

        return contents;
    }
}
