/**
 * @module core/provider/capabilities/ModerationCapability.ts
 * @description Provider-agnostic moderation capability contracts.
 */
import { AIRequest, AIResponse, MultiModalExecutionContext, NormalizedModeration, ProviderCapability } from "#root/index.js";

/**
 * Provider-agnostic moderation capability interface.
 *
 * Providers that implement this interface can evaluate content for safety/violations.
 *
 * @template TModerationInput - Input type for the moderation request.
 * @template TOutput - Output type for normalized moderation results.
 */
export interface ModerationCapability<TModerationInput = any, TOutput = NormalizedModeration[]> extends ProviderCapability {
    /**
     * Evaluate input for moderation purposes.
     *
     * @param {AIRequest<TModerationInput>} req - AIRequest containing moderation input.
     * @param {MultiModalExecutionContext} ctx - Execution context.
     * @param {AbortSignal | undefined} signal - AbortSignal for request cancellation.
     * @returns {Promise<AIResponse<TOutput>>} AIResponse wrapping moderation results.
     */
    moderation(
        req: AIRequest<TModerationInput>,
        ctx: MultiModalExecutionContext,
        signal?: AbortSignal
    ): Promise<AIResponse<TOutput>>;
}
