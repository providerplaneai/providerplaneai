import { AIRequest, AIResponse, MultiModalExecutionContext, NormalizedModeration, ProviderCapability } from "#root/index.js";

/**
 * Provider-agnostic moderation capability interface.
 *
 * Providers that implement this interface can evaluate content for safety/violations.
 *
 * @template TModerationInput Input type for moderation request
 * @template TOutput Output type (single or array of moderation results)
 */
export interface ModerationCapability<
    TModerationInput = any,
    TOutput = NormalizedModeration[]> extends ProviderCapability {
    /**
     * Evaluate input for moderation purposes.
     *
     * @param req AIRequest containing moderation input
     * @param ctx execution context
     * @param signal AbortSignal for request cancellation
     * @returns AIResponse wrapping moderation results
     */
    moderation(req: AIRequest<TModerationInput>, ctx: MultiModalExecutionContext, signal?: AbortSignal): Promise<AIResponse<TOutput>>;
}
