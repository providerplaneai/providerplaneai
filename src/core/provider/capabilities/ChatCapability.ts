/**
 * @module core/provider/capabilities/ChatCapability.ts
 * @description Provider-agnostic chat capability contracts.
 */
import { AIRequest, AIResponse, AIResponseChunk, MultiModalExecutionContext, ProviderCapability } from "#root/index.js";

/**
 * Provider-agnostic chat (non-streaming) capability interface.
 *
 * Providers that implement this interface can handle chat requests.
 *
 * @template TChatInput - Input type for chat messages.
 * @template TChatOutput - Output type for chat responses.
 */
export interface ChatCapability<TChatInput = unknown, TChatOutput = unknown> extends ProviderCapability {
    /**
     * Execute a chat request.
     *
     * @param {AIRequest<TChatInput>} request - AIRequest containing chat input.
     * @param {MultiModalExecutionContext} ctx - Execution context.
     * @param {AbortSignal | undefined} signal - Optional abort signal.
     * @returns {Promise<AIResponse<TChatOutput>>} AIResponse wrapping the assistant's reply.
     */
    chat(
        request: AIRequest<TChatInput>,
        ctx: MultiModalExecutionContext,
        signal?: AbortSignal
    ): Promise<AIResponse<TChatOutput>>;
}

/**
 * Provider-agnostic streaming chat capability interface.
 *
 * Allows streaming partial responses for chat.
 *
 * @template TChatInput - Input type for chat messages.
 * @template TChatOutput - Output type for chat responses.
 */
export interface ChatStreamCapability<TChatInput = unknown, TChatOutput = unknown> extends ProviderCapability {
    /**
     * Execute a streaming chat request.
     * Yields partial responses as they are generated.
     *
     * @param {AIRequest<TChatInput>} request - AIRequest containing chat input.
     * @param {MultiModalExecutionContext} ctx - Execution context.
     * @param {AbortSignal | undefined} signal - Optional abort signal.
     * @returns {AsyncGenerator<AIResponseChunk<TChatOutput>>} Async generator yielding response chunks.
     */
    chatStream(
        request: AIRequest<TChatInput>,
        ctx: MultiModalExecutionContext,
        signal?: AbortSignal
    ): AsyncGenerator<AIResponseChunk<TChatOutput>>;
}
