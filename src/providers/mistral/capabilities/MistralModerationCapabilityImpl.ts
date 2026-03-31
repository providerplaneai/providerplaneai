/**
 * @module providers/mistral/capabilities/MistralModerationCapabilityImpl.ts
 * @description Mistral moderation capability adapter.
 */
import { Mistral } from "@mistralai/mistralai";
import {
    AIProvider,
    AIRequest,
    AIResponse,
    BaseProvider,
    CapabilityKeys,
    ClientModerationRequest,
    ModerationCapability,
    MultiModalExecutionContext,
    NormalizedModeration
} from "#root/index.js";

const DEFAULT_MISTRAL_MODERATION_MODEL = "mistral-moderation-latest";

/**
 * Adapts Mistral moderation and classifier responses into ProviderPlaneAI's
 * normalized moderation artifact surface.
 *
 * Accepts a single string or an array of strings, executes Mistral's classifier
 * moderation endpoint, and normalizes category booleans, category scores,
 * `flagged`, and `reason` into `NormalizedModeration[]`.
 *
 * @public
 * @description Provider capability implementation for MistralModerationCapabilityImpl.
 */
export class MistralModerationCapabilityImpl implements ModerationCapability<ClientModerationRequest, NormalizedModeration[]> {
    /**
     * Creates a new Mistral moderation capability adapter.
     *
     * @param {BaseProvider} provider Owning provider instance used for initialization checks and merged config access.
     * @param {Mistral} client Initialized official Mistral SDK client.
     */
    constructor(
        private readonly provider: BaseProvider,
        private readonly client: Mistral
    ) {}

    /**
     * Executes a Mistral moderation request.
     *
     * Responsibilities:
     * - normalize single-string and multi-string moderation input into an array
     * - execute `classifiers.moderate` through the official SDK
     * - convert category booleans/scores into normalized moderation artifacts
     * - derive `flagged` and `reason` from the flagged category set
     * - return top-level provider/model/request metadata for the moderation call
     *
     * @param {AIRequest<ClientModerationRequest>} request Unified moderation request envelope.
     * @param {MultiModalExecutionContext} [_ctx] Optional execution context. Unused directly in this adapter.
     * @param {AbortSignal} [signal] Optional cancellation signal.
     * @throws {Error} When input is invalid, aborted, or Mistral returns no moderation results.
     * @returns {Promise<AIResponse<NormalizedModeration[]>>} Provider-normalized moderation artifacts.
     */
    async moderation(
        request: AIRequest<ClientModerationRequest>,
        _ctx?: MultiModalExecutionContext,
        signal?: AbortSignal
    ): Promise<AIResponse<NormalizedModeration[]>> {
        this.provider.ensureInitialized();

        if (signal?.aborted) {
            throw new Error("Request aborted");
        }

        const { input, options, context } = request;
        if (!input?.input) {
            throw new Error("Invalid moderation input");
        }

        const merged = this.provider.getMergedOptions(CapabilityKeys.ModerationCapabilityKey, options);
        const model = merged.model ?? DEFAULT_MISTRAL_MODERATION_MODEL;
        // Normalize to the provider's batch input shape so single and multi-input moderation
        // follow the same execution and normalization path.
        const inputs = Array.isArray(input.input) ? input.input : [input.input];
        const response = await this.client.classifiers.moderate(
            {
                model,
                inputs
            },
            { signal, ...(merged.providerParams ?? {}) }
        );

        if (!response.results?.length) {
            throw new Error("Mistral returned no moderation results");
        }

        const normalized: NormalizedModeration[] = response.results.map((result, index) => {
            // Normalize provider categories to booleans even if the underlying SDK evolves
            // into a mixed-value shape for some classifiers.
            const categories = Object.fromEntries(
                Object.entries(result.categories ?? {}).map(([key, value]) => [key, Boolean(value)])
            );
            const categoryScores = result.categoryScores;
            const flaggedCategoryNames = Object.entries(categories)
                .filter(([, value]) => value)
                .map(([key]) => key);

            return {
                id: crypto.randomUUID(),
                // Derive the summary flag and human-readable reason from normalized categories
                // so downstream behavior stays stable even if provider flags evolve.
                flagged: flaggedCategoryNames.length > 0,
                categories,
                categoryScores,
                reason: flaggedCategoryNames.length > 0 ? flaggedCategoryNames.join(", ") : undefined,
                inputIndex: index,
                metadata: {
                    provider: AIProvider.Mistral,
                    model,
                    requestId: context?.requestId
                }
            };
        });

        return {
            output: normalized,
            rawResponse: response,
            id: response.id ?? crypto.randomUUID(),
            metadata: {
                ...(context?.metadata ?? {}),
                provider: AIProvider.Mistral,
                model,
                status: "completed",
                requestId: context?.requestId
            }
        };
    }
}
