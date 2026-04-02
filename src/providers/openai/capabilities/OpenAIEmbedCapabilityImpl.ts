/**
 * @module providers/openai/capabilities/OpenAIEmbedCapabilityImpl.ts
 * @description OpenAI embedding capability adapter.
 */
import OpenAI from "openai";
import {
    AIProvider,
    AIRequest,
    AIResponse,
    BaseProvider,
    CapabilityKeys,
    ClientEmbeddingRequest,
    EmbedCapability,
    MultiModalExecutionContext,
    NormalizedEmbedding,
    buildMetadata
} from "#root/index.js";

const DEFAULT_OPENAI_EMBED_MODEL = "text-embedding-3-large";

/**
 * Adapts OpenAI embeddings into ProviderPlaneAI's normalized embedding artifact surface.
 *
 * Supports scalar and batched embedding inputs, preserves provider ordering, and
 * attaches normalized usage and request metadata to each returned embedding.
 *
 * @public
 */
export class OpenAIEmbedCapabilityImpl implements EmbedCapability<ClientEmbeddingRequest, NormalizedEmbedding[]> {
    /**
     * Creates a new OpenAI embedding capability adapter.
     *
     * @param {BaseProvider} provider Owning provider instance used for initialization checks and merged config access.
     * @param {OpenAI} client Initialized OpenAI SDK client.
     */
    constructor(
        private readonly provider: BaseProvider,
        private readonly client: OpenAI
    ) {}

    /**
     * Executes an OpenAI embeddings request.
     *
     * Responsibilities:
     * - validate embedding input
     * - resolve merged model/runtime options
     * - execute `embeddings.create` through the official SDK
     * - normalize returned vectors into `NormalizedEmbedding[]`
     * - attach provider/model/usage metadata to the response
     *
     * @param {AIRequest<ClientEmbeddingRequest>} request Unified embedding request envelope.
     * @param {MultiModalExecutionContext} [_executionContext] Optional execution context. Unused directly in this adapter.
     * @param {AbortSignal} [signal] Optional cancellation signal.
     * @returns {Promise<AIResponse<NormalizedEmbedding[]>>} Provider-normalized embedding artifacts.
     * @throws {Error} When input is invalid or OpenAI returns no embeddings.
     */
    async embed(
        request: AIRequest<ClientEmbeddingRequest>,
        _executionContext?: MultiModalExecutionContext,
        signal?: AbortSignal
    ): Promise<AIResponse<NormalizedEmbedding[]>> {
        // Ensure provider lifecycle has been initialized
        this.provider.ensureInitialized();

        const { input, options, context } = request;
        // Defensive validation: embeddings require at least one input
        if (!input?.input) {
            throw new Error("Invalid embedding input");
        }

        // Merge general, provider, model, and request-level options
        const merged = this.provider.getMergedOptions(CapabilityKeys.EmbedCapabilityKey, options);

        // OpenAI supports batch embeddings in a single API call
        const response: OpenAI.Embeddings.CreateEmbeddingResponse = await this.client.embeddings.create(
            {
                model: merged.model ?? DEFAULT_OPENAI_EMBED_MODEL,
                input: input.input,
                ...(merged.modelParams ?? {}),
                ...(merged.providerParams ?? {})
            },
            { signal }
        );

        if (!response.data || response.data.length === 0) {
            throw new Error("OpenAI returned no embeddings");
        }

        // Map each input to a NormalizedEmbedding artifact
        const normalized: NormalizedEmbedding[] = response.data.map((d, _idx) => ({
            id: crypto.randomUUID(),
            vector: d.embedding,
            dimensions: d.embedding.length,
            inputId: Array.isArray(input.input) ? undefined : (input as any).inputId,
            purpose: (request as any)?.purpose ?? "embedding",
            metadata: buildMetadata(undefined, {
                provider: AIProvider.OpenAI,
                model: merged.model,
                status: "completed",
                tokensUsed: (response as any)?.usage?.total_tokens,
                requestId: context?.requestId
            })
        }));

        // Return normalized AIResponse
        return {
            output: normalized,
            rawResponse: response,
            id: crypto.randomUUID(),
            metadata: buildMetadata(context?.metadata, {
                provider: AIProvider.OpenAI,
                model: merged.model,
                status: "completed",
                tokensUsed: (response as any)?.usage?.total_tokens,
                requestId: context?.requestId
            })
        };
    }
}
