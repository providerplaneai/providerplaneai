/**
 * @module providers/mistral/capabilities/MistralModerationCapabilityImpl.ts
 * @description Mistral moderation capability adapter.
 */
import { Mistral } from "@mistralai/mistralai";
import type { ClassificationRequest } from "@mistralai/mistralai/models/components";
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
 * MistralModerationCapabilityImpl: adapts Mistral moderation/classifier responses
 * into ProviderPlaneAI's normalized moderation artifact surface.
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
     * - normalize single-string and multi-string moderation input
     * - execute `classifiers.moderate` through the official SDK
     * - convert category booleans/scores into normalized moderation artifacts
     * - derive `flagged`/`reason` from the flagged category set
     *
     * @param {AIRequest<ClientModerationRequest>} request Unified moderation request envelope.
     * @param {MultiModalExecutionContext} [_executionContext] Optional execution context. Unused directly in this adapter.
     * @param {AbortSignal} [signal] Optional cancellation signal.
     * @throws {Error} When input is invalid, aborted, or Mistral returns no moderation results.
     * @returns {Promise<AIResponse<NormalizedModeration[]>>} Provider-normalized moderation artifacts.
     */
    async moderation(
        request: AIRequest<ClientModerationRequest>,
        _executionContext?: MultiModalExecutionContext,
        signal?: AbortSignal
    ): Promise<AIResponse<NormalizedModeration[]>> {
        this.provider.ensureInitialized();

        const { input, options, context } = request;
        if (!input?.input) {
            throw new Error("Invalid moderation input");
        }
        if (signal?.aborted) {
            throw new Error("Request aborted");
        }

        const merged = this.provider.getMergedOptions(CapabilityKeys.ModerationCapabilityKey, options);
        const inputs = Array.isArray(input.input) ? input.input : [input.input];
        const response = await this.client.classifiers.moderate(
            this.buildClassificationRequest(merged.model ?? DEFAULT_MISTRAL_MODERATION_MODEL, inputs),
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
                flagged: flaggedCategoryNames.length > 0,
                categories,
                categoryScores,
                reason: flaggedCategoryNames.length > 0 ? flaggedCategoryNames.join(", ") : undefined,
                inputIndex: index,
                metadata: {
                    provider: AIProvider.Mistral,
                    model: merged.model ?? response.model ?? DEFAULT_MISTRAL_MODERATION_MODEL,
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
                model: merged.model ?? response.model ?? DEFAULT_MISTRAL_MODERATION_MODEL,
                status: "completed",
                requestId: context?.requestId
            }
        };
    }

    /**
     * Builds a typed moderation/classification request for the Mistral SDK.
     *
     * The current SDK request type only accepts `model` and `inputs`, so model
     * params are intentionally not spread here.
     *
     * @param {string} model Resolved model name.
     * @param {string[]} inputs Moderation input batch.
     * @returns {ClassificationRequest} SDK-compatible moderation request.
     */
    private buildClassificationRequest(model: string, inputs: string[]): ClassificationRequest {
        return {
            model,
            inputs
        };
    }
}
