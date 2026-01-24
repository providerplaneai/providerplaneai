import { GoogleGenAI } from "@google/genai";
import {
    AIProvider,
    AIRequest,
    AIResponse,
    BaseProvider,
    CapabilityKeys,
    ClientEmbeddingRequest,
    EmbedCapability,
    MultiModalExecutionContext
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
export class GeminiEmbedCapabilityImpl implements EmbedCapability<ClientEmbeddingRequest, number[] | number[][]> {
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
     * @returns AIResponse with single vector or array of vectors
     * @throws Error if input is invalid or API returns no embeddings
     */
    async embed(
        request: AIRequest<ClientEmbeddingRequest>,
        _executionContext?: MultiModalExecutionContext
    ): Promise<AIResponse<number[] | number[][]>> {
        // Ensure provider lifecycle has been initialized
        this.provider.ensureInitialized();

        const { input, options, context } = request;
        // Defensive validation: Gemini requires at least one input
        if (!input?.input) {
            throw new Error("Invalid embedding input");
        }

        // Merge general, provider, model, and request-level options
        const merged = this.provider.getMergedOptions(CapabilityKeys.EmbedCapabilityKey, options);

        // Normalize single input to array for batch processing
        const inputs = Array.isArray(input.input) ? input.input : [input.input];

        // Gemini supports batching natively in one call logic
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

        // Extract and filter to ensure we only have number arrays
        // We use .filter(Boolean) to remove any undefined entries and 'as number[][]' to satisfy the interface
        const vectors = response.embeddings.map((e) => e.values).filter((v): v is number[] => !!v);

        if (vectors.length === 0) {
            throw new Error("API returned embeddings but all values were undefined");
        }

        // Return fully normalized AIResponse
        return {
            output: Array.isArray(input.input) ? vectors : vectors[0],
            rawResponse: response,
            metadata: {
                provider: AIProvider.Gemini,
                model: merged.model,
                status: "completed",
                // Note: Gemini embeddings API doesn't always return usage in the same field as chat
                tokensUsed: (response as any).usageMetadata?.totalTokenCount,
                requestId: context?.requestId,
                ...(context?.metadata ?? {})
            }
        };
    }
}
