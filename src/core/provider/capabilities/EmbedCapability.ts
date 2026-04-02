/**
 * @module core/provider/capabilities/EmbedCapability.ts
 * @description Provider-agnostic embedding capability contracts.
 */
import { AIRequest, AIResponse, MultiModalExecutionContext, ProviderCapability } from "#root/index.js";

/**
 * Provider-agnostic embedding capability interface.
 *
 * Providers that implement this interface can create embeddings for text or other data.
 *
 * @template TEmbedInput - Input type for embedding.
 * @template TOutput - Output type for normalized embedding results.
 */
export interface EmbedCapability<TEmbedInput = any, TOutput = any> extends ProviderCapability {
    /**
     * Generate embeddings for the given input.
     *
     * @param {AIRequest<TEmbedInput>} req - AIRequest containing embedding input.
     * @param {MultiModalExecutionContext} ctx - Execution context.
     * @param {AbortSignal | undefined} signal - AbortSignal for request cancellation.
     * @returns {Promise<AIResponse<TOutput>>} AIResponse wrapping the embedding output.
     */
    embed(req: AIRequest<TEmbedInput>, ctx: MultiModalExecutionContext, signal?: AbortSignal): Promise<AIResponse<TOutput>>;
}
