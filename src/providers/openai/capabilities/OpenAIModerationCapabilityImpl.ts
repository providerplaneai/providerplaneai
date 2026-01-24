import OpenAI from "openai";
import {
    AIProvider,
    AIRequest,
    AIResponse,
    BaseProvider,
    CapabilityKeys,
    ClientModerationRequest,
    ModerationCapability,
    ModerationResult,
    MultiModalExecutionContext
} from "#root/index.js";

/**
 * OpenAIModerationCapabilityImpl: Implements moderation for OpenAI using the moderation API.
 *
 * Responsibilities:
 * - Implements the unified IModerationCapability interface for OpenAI
 * - Supports single or multiple text inputs
 * - Normalizes OpenAI moderation responses into provider-agnostic ModerationResult[]
 * - Extracts flagged categories, category scores, and a summary reason
 * - Provides execution context, token usage, and error handling
 *
 * Note:
 * OpenAI provides a dedicated moderation API (omni-moderation-latest),
 * which returns flagged status, categories, and category confidence scores.
 */
export class OpenAIModerationCapabilityImpl implements ModerationCapability<
    ClientModerationRequest,
    ModerationResult | ModerationResult[]
> {
    /**
     * Constructs a new OpenAI moderation capability.
     *
     * @param provider - Owning provider instance for lifecycle and config access
     * @param client - Initialized OpenAI SDK client
     */
    constructor(
        private readonly provider: BaseProvider,
        private readonly client: OpenAI
    ) {}

    /**
     * Performs moderation on one or more input strings.
     *
     * Flow:
     * - Validate input and ensure at least one string is provided
     * - Initialize capability execution context
     * - Merge model and provider parameters
     * - Call OpenAI moderation endpoint
     * - Normalize results to provider-agnostic ModerationResult format
     * - Aggregate token usage and metadata
     *
     * @param request - Unified moderation request
     * @param _executionContext Optional execution context
     * @returns AIResponse containing moderation result(s)
     * @throws Error if input is invalid or API fails
     */
    async moderation(
        request: AIRequest<ClientModerationRequest>,
        _executionContext?: MultiModalExecutionContext
    ): Promise<AIResponse<ModerationResult | ModerationResult[]>> {
        // Ensure provider lifecycle has completed
        this.provider.ensureInitialized();

        const { input, options, context } = request;
        // Defensive validation: Require at least one input string
        if (!input?.input) {
            throw new Error("Invalid moderation input");
        }

        // Merge general, provider, model, and request-level options
        const merged = this.provider.getMergedOptions(CapabilityKeys.ModerationCapabilityKey, options);

        // Call OpenAI moderation API
        const response = await this.client.moderations.create({
            model: merged.model ?? "omni-moderation-latest",
            input: input.input,
            ...(merged.modelParams ?? {}),
            ...(merged.providerParams ?? {})
        });

        /**
         * Normalize OpenAI moderation results:
         * - flagged: boolean
         * - categories: object with category flags
         * - categoryScores: numeric confidence scores (0–1)
         * - reason: comma-separated list of flagged categories
         */
        const results: ModerationResult[] = response.results.map((r) => ({
            flagged: r.flagged,
            categories: Object.fromEntries(Object.entries(r.categories ?? {}).map(([k, v]) => [k, Boolean(v)])),
            categoryScores: Object.fromEntries(Object.entries(r.category_scores ?? {}).map(([k, v]) => [k, Number(v)])),
            raw: r,
            reason: Object.entries(r.categories ?? {})
                .filter(([_, flagged]) => flagged)
                .map(([cat]) => cat)
                .join(", ")
        }));

        // Normalize output: single string input -> single ModerationResult, else array
        const normalizedOutput = Array.isArray(input.input) ? results : results[0];

        // Return fully normalized AIResponse
        return {
            output: normalizedOutput,
            rawResponse: response,
            id: response.id,
            metadata: {
                provider: AIProvider.OpenAI,
                model: merged.model,
                status: "completed",
                tokensUsed: (response as any)?.usage?.total_tokens,
                requestId: context?.requestId,
                ...(context?.metadata ?? {})
            }
        };
    }
}
