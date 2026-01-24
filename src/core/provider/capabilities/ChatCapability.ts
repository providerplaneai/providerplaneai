import { AIRequest, AIResponse, AIResponseChunk, MultiModalExecutionContext, ProviderCapability } from "#root/index.js";

/**
 * Provider-agnostic chat (non-streaming) capability interface.
 *
 * Providers that implement this interface can handle chat requests.
 *
 * @template TChatInput Input type for chat messages
 * @template TChatOutput Output type for chat responses
 */
export interface ChatCapability<TChatInput = unknown, TChatOutput = unknown> extends ProviderCapability {
    /**
     * Execute a chat request.
     *
     * @param req AIRequest containing chat input
     * @param ctx Execution context
     * @returns AIResponse wrapping the assistant's reply
     */
    chat(request: AIRequest<TChatInput>, ctx: MultiModalExecutionContext): Promise<AIResponse<TChatOutput>>;
}

/**
 * Provider-agnostic streaming chat capability interface.
 *
 * Allows streaming partial responses for chat.
 *
 * @template TChatInput Input type for chat messages
 * @template TChatOutput Output type for chat responses
 */
export interface ChatStreamCapability<TChatInput = unknown, TChatOutput = unknown> extends ProviderCapability {
    /**
     * Execute a streaming chat request.
     * Yields partial responses as they are generated.
     *
     * @param req AIRequest containing chat input
     * @param ctx Execution context
     * @returns AsyncGenerator yielding AIResponseChunk objects
     */
    chatStream(request: AIRequest<TChatInput>, ctx: MultiModalExecutionContext): AsyncGenerator<AIResponseChunk<TChatOutput>>;
}
