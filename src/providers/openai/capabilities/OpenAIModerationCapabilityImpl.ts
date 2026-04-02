/**
 * @module providers/openai/capabilities/OpenAIModerationCapabilityImpl.ts
 * @description OpenAI moderation capability adapter.
 */
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
    MultiModalExecutionContext,
    buildMetadata
} from "#root/index.js";

const DEFAULT_OPENAI_MODERATION_MODEL = "omni-moderation-latest";

/**
 * Adapts OpenAI moderation responses into ProviderPlaneAI's normalized moderation artifact surface.
 *
 * Supports scalar and batched moderation input, forwards model overrides to the
 * dedicated OpenAI moderation endpoint, and normalizes category booleans and scores.
 *
 * @public
 */
export class OpenAIModerationCapabilityImpl implements ModerationCapability<ClientModerationRequest, NormalizedModeration[]> {
    /**
     * Creates a new OpenAI moderation capability adapter.
     *
     * @param {BaseProvider} provider Owning provider instance used for initialization checks and merged config access.
     * @param {OpenAI} client Initialized OpenAI SDK client.
     */
    constructor(
        private readonly provider: BaseProvider,
        private readonly client: OpenAI
    ) {}

    /**
     * Executes an OpenAI moderation request.
     *
     * Responsibilities:
     * - validate moderation input
     * - resolve merged model/runtime options
     * - normalize scalar input into the provider's batched request shape
     * - execute `moderations.create`
     * - attach provider/model/request metadata to normalized outputs
     *
     * @param {AIRequest<ClientModerationRequest>} request Unified moderation request envelope.
     * @param {MultiModalExecutionContext} [_executionContext] Optional execution context. Unused directly in this adapter.
     * @param {AbortSignal} [signal] Optional cancellation signal.
     * @returns {Promise<AIResponse<NormalizedModeration[]>>} Provider-normalized moderation artifacts.
     * @throws {Error} When input is invalid, aborted, or OpenAI returns no moderation results.
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
                model: merged.model ?? DEFAULT_OPENAI_MODERATION_MODEL,
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
            const categories: Record<string, boolean> = {};
            const flaggedCategoryNames: string[] = [];
            const categoriesSource = (r.categories ?? {}) as unknown as Record<string, unknown>;
            for (const key in categoriesSource) {
                const flagged = Boolean(categoriesSource[key]);
                categories[key] = flagged;
                if (flagged) {
                    flaggedCategoryNames.push(key);
                }
            }

            const categoryScoresSource = r.category_scores as unknown as Record<string, unknown> | undefined;
            let hasCategoryScores = false;
            const categoryScores: Record<string, number> = {};
            for (const key in categoryScoresSource ?? {}) {
                categoryScores[key] = Number(categoryScoresSource![key]);
                hasCategoryScores = true;
            }

            return {
                id: crypto.randomUUID(),
                flagged: r.flagged,
                categories,
                categoryScores: hasCategoryScores ? categoryScores : undefined,
                reason: flaggedCategoryNames.length > 0 ? flaggedCategoryNames.join(", ") : undefined,
                metadata: buildMetadata(undefined, {
                    provider: AIProvider.OpenAI,
                    model: merged.model ?? DEFAULT_OPENAI_MODERATION_MODEL,
                    inputIndex: index,
                    requestId: context?.requestId
                })
            };
        });

        return {
            output: normalized,
            rawResponse: response,
            id: crypto.randomUUID(),
            metadata: buildMetadata(context?.metadata, {
                provider: AIProvider.OpenAI,
                model: merged.model ?? DEFAULT_OPENAI_MODERATION_MODEL,
                status: "completed",
                requestId: context?.requestId
            })
        };
    }
}
