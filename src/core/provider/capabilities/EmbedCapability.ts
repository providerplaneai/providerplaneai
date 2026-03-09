/**
 * @module core/provider/capabilities/EmbedCapability.ts
 * @description Provider implementations and capability adapters.
 */
import { AIRequest, AIResponse, MultiModalExecutionContext, ProviderCapability } from "#root/index.js";

/**
 * Provider-agnostic embedding capability interface.
 *
 * Providers that implement this interface can create embeddings for text or other data.
 *
 * @template TEmbedInput Input type for embedding
 * @template TOutput Output type (vector or array of vectors)
 */
export interface EmbedCapability<TEmbedInput = any, TOutput = any> extends ProviderCapability {
    /**
     * Generate embeddings for the given input.
     *
     * @param req AIRequest containing embedding input
     * @param ctx Execution context
     * @param signal AbortSignal for request cancellation
     * @returns AIResponse wrapping the embedding(s)
     */
    embed(req: AIRequest<TEmbedInput>, ctx: MultiModalExecutionContext, signal?: AbortSignal): Promise<AIResponse<TOutput>>;
}
