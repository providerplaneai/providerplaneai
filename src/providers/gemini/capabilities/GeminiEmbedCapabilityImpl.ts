import { GoogleGenAI } from "@google/genai";
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
 * GeminiEmbedCapabilityImpl: Implements embedding capability for Gemini.
 *
 * Responsibilities:
 * - Implements unified IEmbedCapability interface for Gemini embeddings
 * - Normalizes provider-specific response to AIResponse<number[] | number[][]>
 * - Handles batching of multiple inputs in one API request
 * - Provides full execution context, metadata, and error handling
 *
 * Note:
 * Gemini embedding API supports "taskType" and "outputDimensionality" as modelParams for advanced configuration.
 */
export class GeminiEmbedCapabilityImpl implements EmbedCapability<ClientEmbeddingRequest, NormalizedEmbedding[]> {
    /**
     * Constructs a Gemini embedding capability.
     *
     * @param provider - Owning provider instance
     * @param client - Initialized Gemini SDK client
     */
    constructor(
        private readonly provider: BaseProvider,
        private readonly client: GoogleGenAI
    ) {}

    /**
     * Generates embeddings for one or more input strings.
     *
     * Flow:
     * - Validate input
     * - Initialize capability execution context
     * - Normalize input to array for batch processing
     * - Call Gemini embeddings API
     * - Extract numeric vectors, preserving order
     * - Return normalized AIResponse with metadata
     *
     * @param request - Unified embedding request
     * @param _executionContext Optional execution context
     * @param signal Optional abort signal
     * @returns AIResponse with single vector or array of vectors
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
        // Defensive validation: Gemini requires at least one input
        if (!input?.input) {
            throw new Error("Invalid embedding input");
        }

        if (signal?.aborted) {
            throw new Error("Request aborted");
        }

        // Merge general, provider, model, and request-level options
        const merged = this.provider.getMergedOptions(CapabilityKeys.EmbedCapabilityKey, options);

        // Normalize single input to array for batch processing
        const inputs = Array.isArray(input.input) ? input.input : [input.input];

        const response = await this.client.models.embedContent({
            model: merged.model ?? "text-embedding-004",
            contents: inputs.map((t) => ({ parts: [{ text: t }] })),
            config: {
                // TaskType is Gemini's unique feature.
                // It defaults to 'RETRIEVAL_QUERY' if not provided.
                taskType: merged.modelParams?.taskType || "RETRIEVAL_QUERY",
                outputDimensionality: merged.modelParams?.dimensions
            }
        });

        // Guard against undefined embeddings
        if (!response.embeddings || response.embeddings.length === 0) {
            throw new Error("API returned no embeddings");
        }

        if (response.embeddings.length !== inputs.length) {
            throw new Error(`Gemini returned ${response.embeddings.length} embeddings for ${inputs.length} inputs`);
        }

        const normalized: NormalizedEmbedding[] = response.embeddings.map((e, idx) => {
            if (!e.values) {
                throw new Error(`Gemini embedding at index ${idx} is missing values`);
            }

            return {
                id: crypto.randomUUID(),
                vector: e.values,
                dimensions: e.values.length,
                purpose: (request as any)?.purpose ?? "embedding",
                metadata: {
                    provider: AIProvider.Gemini,
                    model: merged.model,
                    status: "completed",
                    tokensUsed: (response as any)?.usageMetadata?.totalTokenCount,
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
                provider: AIProvider.Gemini,
                model: merged.model,
                status: "completed",
                tokensUsed: (response as any)?.usageMetadata?.totalTokenCount,
                requestId: context?.requestId
            }
        };
    }
}
