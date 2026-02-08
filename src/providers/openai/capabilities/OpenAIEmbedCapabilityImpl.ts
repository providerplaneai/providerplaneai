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
    NormalizedEmbedding
} from "#root/index.js";

/**
 * OpenAIEmbedCapabilityImpl: Implements embedding capability for OpenAI.
 *
 * Responsibilities:
 * - Implements the unified IEmbedCapability interface for OpenAI embeddings
 * - Normalizes OpenAI-specific embedding responses into AIResponse<NormalizedEmbedding>
 * - Handles single or batch inputs transparently
 * - Provides execution context, metadata, and error handling
 *
 * Note:
 * The OpenAI embeddings API supports multiple models (e.g., text-embedding-3-large)
 * and allows customization via modelParams and providerParams.
 */
export class OpenAIEmbedCapabilityImpl implements EmbedCapability<ClientEmbeddingRequest, NormalizedEmbedding[]> {
    /**
     * Constructs a new OpenAI embedding capability.
     *
     * @param provider - Owning provider instance
     * @param client - Initialized OpenAI SDK client
     */
    constructor(
        private readonly provider: BaseProvider,
        private readonly client: OpenAI
    ) {}

    /**
     * Generates embeddings for one or more input strings.
     *
     * Flow:
     * - Validate input
     * - Initialize capability execution context
     * - Normalize input to array for batch processing
     * - Call OpenAI embeddings API
     * - Extract numeric vectors, preserving order
     * - Return normalized AIResponse with metadata
     *
     * @param request - Unified embedding request
     * @param _executionContext Optional execution context
     * @param signal Optional abort signal
     * @returns AIResponse containing a single vector or array of vectors
     * @throws Error if input is invalid or API returns no embeddings
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

        // Normalize input into array for batch processing
        const inputs = Array.isArray(input.input) ? input.input : [input.input];

        // Merge general, provider, model, and request-level options
        const merged = this.provider.getMergedOptions(CapabilityKeys.EmbedCapabilityKey, options);

        // OpenAI supports batch embeddings in a single API call
        const response: OpenAI.Embeddings.CreateEmbeddingResponse = await this.client.embeddings.create({
            model: merged.model ?? "text-embedding-3-large",
            input: input.input,
            ...(merged.modelParams ?? {}),
            ...(merged.providerParams ?? {})
        }, {signal});

        if (!response.data || response.data.length === 0) {
            throw new Error("OpenAI returned no embeddings");
        }

        // Map each input to a NormalizedEmbedding artifact
        const normalized: NormalizedEmbedding[] = response.data.map((d, idx) => ({
            id: crypto.randomUUID(),
            vector: d.embedding,
            dimensions: d.embedding.length,
            inputId: Array.isArray(input.input) ? undefined : (input as any).inputId,
            purpose: (request as any)?.purpose ?? "embedding",
            metadata: {
                provider: AIProvider.OpenAI,
                model: merged.model,
                status: "completed",
                tokensUsed: (response as any)?.usage?.total_tokens,
                requestId: context?.requestId
            }
        }));        

        // Return normalized AIResponse
        return {
            output: normalized,
            rawResponse: response,
            id: crypto.randomUUID(),
            metadata: {
                ...(context?.metadata ?? {}),
                provider: AIProvider.OpenAI,
                model: merged.model,
                status: "completed",
                tokensUsed: (response as any)?.usage?.total_tokens,
                requestId: context?.requestId
            }
        };
    }
}
