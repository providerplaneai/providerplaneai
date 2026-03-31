/**
 * @module providers/mistral/capabilities/MistralEmbedCapabilityImpl.ts
 * @description Mistral embedding capability adapter.
 */
import { Mistral } from "@mistralai/mistralai";
import type { EmbeddingRequest, UsageInfo } from "@mistralai/mistralai/models/components";
import {
    AIProvider,
    AIRequest,
    AIResponse,
    BaseProvider,
    CapabilityKeys,
    ClientEmbeddingRequest,
    EmbedCapability,
    MultiModalExecutionContext,
    NormalizedEmbedding
} from "#root/index.js";

const DEFAULT_MISTRAL_EMBED_MODEL = "mistral-embed";

/**
 * Adapts Mistral embeddings into ProviderPlaneAI's normalized embedding artifact surface.
 *
 * Executes Mistral's embeddings API, preserves deterministic vector ordering,
 * and normalizes embedding outputs into `NormalizedEmbedding[]`.
 *
 * @public
 * @description Provider capability implementation for MistralEmbedCapabilityImpl.
 */
export class MistralEmbedCapabilityImpl implements EmbedCapability<ClientEmbeddingRequest, NormalizedEmbedding[]> {
    /**
     * Creates a new Mistral embedding capability adapter.
     *
     * @param {BaseProvider} provider Owning provider instance used for initialization checks and merged config access.
     * @param {Mistral} client Initialized official Mistral SDK client.
     */
    constructor(
        private readonly provider: BaseProvider,
        private readonly client: Mistral
    ) {}

    /**
     * Executes a Mistral embeddings request.
     *
     * Responsibilities:
     * - validate embedding input
     * - resolve merged model/runtime options
     * - execute `embeddings.create` through the official SDK
     * - sort embeddings by provider index to preserve deterministic order
     * - attach normalized usage/model metadata
     *
     * @param {AIRequest<ClientEmbeddingRequest>} request Unified embedding request envelope.
     * @param {MultiModalExecutionContext} [_ctx] Optional execution context. Unused directly in this adapter.
     * @param {AbortSignal} [signal] Optional cancellation signal.
     * @throws {Error} When input is invalid, aborted, or Mistral returns no embeddings.
     * @returns {Promise<AIResponse<NormalizedEmbedding[]>>} Provider-normalized embedding artifacts.
     */
    async embed(
        request: AIRequest<ClientEmbeddingRequest>,
        _ctx?: MultiModalExecutionContext,
        signal?: AbortSignal
    ): Promise<AIResponse<NormalizedEmbedding[]>> {
        this.provider.ensureInitialized();

        const { input, options, context } = request;
        if (!input?.input) {
            throw new Error("Invalid embedding input");
        }
        if (signal?.aborted) {
            throw new Error("Request aborted");
        }

        const merged = this.provider.getMergedOptions(CapabilityKeys.EmbedCapabilityKey, options);
        const model = merged.model ?? DEFAULT_MISTRAL_EMBED_MODEL;
        const embeddingRequest = this.buildEmbeddingRequest(model, input.input, merged.modelParams);
        const response = await this.client.embeddings.create(
            embeddingRequest,
            { signal, ...(merged.providerParams ?? {}) }
        );

        if (!response.data?.length) {
            throw new Error("Mistral returned no embeddings");
        }

        const tokensUsed = this.extractTokensUsed(response.usage);
        const normalized = [...response.data]
            // Keep normalization defensive: the SDK types mark these fields optional even
            // though successful embedding rows should contain both index and vector data.
            .filter(
                (item): item is { index: number; embedding: number[] } =>
                    typeof item.index === "number" && Array.isArray(item.embedding)
            )
            // Preserve caller input order even if the provider response arrives out of order.
            .sort((a, b) => a.index - b.index)
            .map((item) => ({
                id: crypto.randomUUID(),
                vector: item.embedding,
                dimensions: item.embedding.length,
                // Scalar inputs can preserve the caller's inputId; batched inputs cannot map
                // a single id cleanly without a broader input-id contract.
                inputId: Array.isArray(input.input) ? undefined : input.inputId,
                purpose: input.purpose ?? "embedding",
                metadata: {
                    provider: AIProvider.Mistral,
                    model,
                    status: "completed",
                    requestId: context?.requestId,
                    tokensUsed
                }
            }));

        return {
            output: normalized,
            rawResponse: response,
            id: response.id ?? crypto.randomUUID(),
            metadata: {
                ...(context?.metadata ?? {}),
                provider: AIProvider.Mistral,
                model,
                status: "completed",
                requestId: context?.requestId,
                tokensUsed
            }
        };
    }

    /**
     * Builds a Mistral embeddings request.
     *
     * @param {string} model Resolved model name.
     * @param {string | string[]} input Embedding input payload.
     * @param {Record<string, unknown> | undefined} modelParams Provider/model-specific request overrides.
     * @returns {EmbeddingRequest} SDK-compatible embeddings request.
     */
    private buildEmbeddingRequest(
        model: string,
        input: string | string[],
        modelParams?: Record<string, unknown>
    ): EmbeddingRequest {
        return {
            model,
            inputs: input,
            ...(modelParams ?? {})
        } as EmbeddingRequest;
    }

    /**
     * Extracts the most useful token count from a Mistral embeddings response.
     *
     * @param {UsageInfo} [usage] SDK usage object.
     * @returns {number | undefined} Total tokens when present, otherwise prompt tokens.
     */
    private extractTokensUsed(usage?: UsageInfo): number | undefined {
        return typeof usage?.totalTokens === "number"
            ? usage.totalTokens
            : typeof usage?.promptTokens === "number"
              ? usage.promptTokens
              : undefined;
    }
}
