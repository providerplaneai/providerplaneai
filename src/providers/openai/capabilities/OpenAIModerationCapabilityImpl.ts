import OpenAI from "openai";
import {
    AIProvider,
    AIRequest,
    AIResponse,
    BaseProvider,
    CapabilityKeys,
    ClientModerationRequest,
    ModerationCapability,
    NormalizedModeration,
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
export class OpenAIModerationCapabilityImpl implements ModerationCapability<ClientModerationRequest, NormalizedModeration[]> {
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
     * @param signal Optional abort signal
     * @returns AIResponse containing moderation result(s)
     * @throws Error if input is invalid or API fails
     */
    async moderation(
        request: AIRequest<ClientModerationRequest>,
        _executionContext?: MultiModalExecutionContext,
        signal?: AbortSignal
    ): Promise<AIResponse<NormalizedModeration[]>> {
        // Ensure provider lifecycle has completed
        this.provider.ensureInitialized();

        if (signal?.aborted) {
            throw new Error("Request aborted");
        }

        const { input, options, context } = request;
        // Defensive validation: Require at least one input string
        if (!input?.input) {
            throw new Error("Invalid moderation input");
        }

        const inputs = Array.isArray(input.input) ? input.input : [input.input];

        // Merge general, provider, model, and request-level options
        const merged = this.provider.getMergedOptions(CapabilityKeys.ModerationCapabilityKey, options);

        // Call OpenAI moderation API
        const response = await this.client.moderations.create(
            {
                model: merged.model ?? "omni-moderation-latest",
                input: inputs,
                ...(merged.modelParams ?? {}),
                ...(merged.providerParams ?? {})
            },
            { signal }
        );

        if (!response.results || response.results.length === 0) {
            throw new Error("OpenAI returned no moderation results");
        }

        const normalized: NormalizedModeration[] = response.results.map((r, index) => {
            const categories = Object.fromEntries(Object.entries(r.categories ?? {}).map(([k, v]) => [k, Boolean(v)]));

            const categoryScores = Object.fromEntries(Object.entries(r.category_scores ?? {}).map(([k, v]) => [k, Number(v)]));

            const reason = Object.entries(categories)
                .filter(([, flagged]) => flagged)
                .map(([k]) => k)
                .join(", ");

            return {
                id: crypto.randomUUID(),
                flagged: r.flagged,
                categories,
                categoryScores: Object.keys(categoryScores).length ? categoryScores : undefined,
                reason: reason || undefined,
                metadata: {
                    provider: AIProvider.OpenAI,
                    model: merged.model ?? "omni-moderation-latest",
                    inputIndex: index,
                    requestId: context?.requestId
                }
            };
        });

        return {
            output: normalized,
            rawResponse: response,
            id: crypto.randomUUID(),
            metadata: {
                ...(context?.metadata ?? {}),
                provider: AIProvider.OpenAI,
                model: merged.model ?? "omni-moderation-latest",
                status: "completed",
                requestId: context?.requestId
            }
        };
    }
}
