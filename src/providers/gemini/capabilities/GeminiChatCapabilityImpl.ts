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
    ClientTextPart,
    MultiModalExecutionContext
} from "#root/index.js";

/**
 * GeminiChatCapabilityImpl: Implements Gemini chat functionality using the official @google/genai SDK.
 *
 * Responsibilities:
 * - Adapt ProviderPlaneAI chat requests to Gemini API
 * - Normalize responses into AIResponse / AIResponseChunk
 * - Support both streaming and non-streaming chat
 *
 * @template TInput - Type of chat request input
 */
export class GeminiChatCapabilityImpl implements ChatCapability<ClientChatRequest>, ChatStreamCapability<ClientChatRequest> {
    /**
     * @param provider - Parent provider instance (for initialization, configuration)
     * @param client - Initialized GoogleGenAI client
     */
    constructor(
        private readonly provider: BaseProvider,
        private readonly client: GoogleGenAI
    ) {}

    /**
     * Executes a non-streaming chat request using Gemini API.
     *
     * @template TChatInput Chat input type
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
        // Defensive validation
        if (!input?.messages?.length) {
            throw new Error("Received empty input messages");
        }

        // Merge general, provider, model, and request-level options
        const merged = this.provider.getMergedOptions(CapabilityKeys.ChatCapabilityKey, options);

        // Generate content via Gemini SDK
        const response = await this.client.models.generateContent({
            model: (merged.model ?? "gemini-2.5-flash-latest").replace(/^models\//, ""),
            contents: this.buildContents(input.messages),
            ...(merged.modelParams ?? {}),
            ...(merged.providerParams ?? {})
        });

        const output = response?.text ?? "";

        // Return a fully normalized response
        return {
            output: output,
            rawResponse: response,
            id: response?.responseId,
            metadata: {
                provider: AIProvider.Gemini,
                model: merged.model,
                status: "completed", // Gemini doesn't seem to have a result status for non-streaming calls so assume complete here
                requestId: context?.requestId
            }
        };
    }

    /**
     * Executes a streaming chat request using Gemini API.
     * Emits incremental response chunks as they are received.
     *
     * @param request - AIRequest containing ClientChatRequest
     * @param _executionContext Optional execution context
     * @returns AsyncGenerator yielding AIResponseChunk<string> objects
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
        try {
            const stream = await this.client.models.generateContentStream({
                model: (merged.model ?? "gemini-2.5-flash-lite").replace(/^models\//, ""),
                contents: this.buildContents(input.messages),
                ...(merged.modelParams ?? {}),
                ...(merged.providerParams ?? {})
            });

            let responseId: string | undefined;
            let accumulatedText = "";
            let buffer = "";

            // Process streaming events
            for await (const chunk of stream) {
                const delta = chunk.text ?? "";
                if (!delta) {
                    continue;
                }
                // Capture first response id (if returned)
                if (!responseId && chunk?.responseId) {
                    responseId = chunk.responseId;
                }

                accumulatedText += delta;
                buffer += delta;

                // Yield partial chunk if batch size reached
                if (buffer.length >= batchSize) {
                    yield {
                        delta: buffer,
                        output: buffer,
                        done: false,
                        id: responseId,
                        metadata: {
                            provider: AIProvider.Gemini,
                            model: merged.model,
                            status: "incomplete",
                            requestId: context?.requestId
                        }
                    };
                    buffer = "";
                }
            }

            // Yield remaining buffer
            if (buffer.length > 0) {
                yield {
                    delta: buffer,
                    output: buffer,
                    done: false,
                    id: responseId,
                    metadata: {
                        provider: AIProvider.Gemini,
                        model: merged.model,
                        status: "incomplete",
                        requestId: context?.requestId
                    }
                };
            }

            // Final chunk indicating completion
            const finishReason = (stream as any)?.finishReason;
            yield {
                delta: "",
                output: accumulatedText,
                done: true,
                id: responseId,
                metadata: {
                    provider: AIProvider.Gemini,
                    model: merged.model,
                    status: this.normalizeGeminiStatus(finishReason),
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
                    provider: AIProvider.Gemini,
                    model: merged.model,
                    status: "error",
                    error: err instanceof Error ? err.message : String(err),
                    requestId: context?.requestId
                }
            };
        }
    }

    /**
     * Converts messages to a single string for Gemini model input.
     * Only text parts are included; non-text parts are ignored.
     *
     * @param messages - Array of ClientChatMessage
     * @returns Concatenated string
     */
    private buildContents(messages: ClientChatMessage[]): string {
        return messages
            .map((m) =>
                m.content
                    .filter((p): p is ClientTextPart => p.type === "text")
                    .map((p) => p.text)
                    .join(" ")
            )
            .join("\n");
    }

    /**
     * Normalizes Gemini finishReason into 'completed' or 'incomplete'.
     */
    private normalizeGeminiStatus(finishReason: string | undefined | null): string {
        switch (finishReason) {
            case "MAX_TOKENS":
                return "incomplete";
            case null:
            case undefined:
            default:
                return "completed";
        }
    }
}
