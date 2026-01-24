import { AIRequest, AIResponse, MultiModalExecutionContext, ProviderCapability } from "#root/index.js";

/**
 * Provider-agnostic embedding capability interface.
 *
 * Providers that implement this interface can create embeddings for text or other data.
 *
 * @template TEmbedInput Input type for embedding
 * @template TOutput Output type (vector or array of vectors)
 */
export interface EmbedCapability<TEmbedInput = any, TOutput = number[] | number[][]> extends ProviderCapability {
    /**
     * Generate embeddings for the given input.
     *
     * @param req AIRequest containing embedding input
     * @param ctx Execution context
     * @returns AIResponse wrapping the embedding(s)
     */
    embed(req: AIRequest<TEmbedInput>, ctx: MultiModalExecutionContext): Promise<AIResponse<TOutput>>;
}
