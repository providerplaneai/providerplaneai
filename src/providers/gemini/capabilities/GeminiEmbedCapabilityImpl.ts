/**
 * @module providers/gemini/capabilities/GeminiEmbedCapabilityImpl.ts
 * @description Gemini embedding capability adapter.
 */
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
    NormalizedEmbedding,
    buildMetadata
} from "#root/index.js";

const DEFAULT_GEMINI_EMBED_MODEL = "gemini-embedding-001";
const DEFAULT_GEMINI_EMBED_TASK_TYPE = "RETRIEVAL_QUERY";

/**
 * Adapts Gemini embeddings into ProviderPlaneAI's normalized embedding artifact surface.
 *
 * Supports scalar and batched embedding inputs, forwards Gemini-specific task
 * options, and normalizes returned vectors into `NormalizedEmbedding[]`.
 *
 * @public
 */
export class GeminiEmbedCapabilityImpl implements EmbedCapability<ClientEmbeddingRequest, NormalizedEmbedding[]> {
    /**
     * Creates a new Gemini embedding capability adapter.
     *
     * @param {BaseProvider} provider Owning provider instance used for initialization checks and merged config access.
     * @param {GoogleGenAI} client Initialized Google GenAI SDK client.
     */
    constructor(
        private readonly provider: BaseProvider,
        private readonly client: GoogleGenAI
    ) {}

    /**
     * Executes a Gemini embeddings request.
     *
     * Responsibilities:
     * - validate embedding input
     * - resolve merged model/runtime options
     * - normalize scalar input into Gemini's batched request shape
     * - execute `models.embedContent`
     * - attach provider/model/usage metadata to normalized embeddings
     *
     * @param {AIRequest<ClientEmbeddingRequest>} request Unified embedding request envelope.
     * @param {MultiModalExecutionContext} [_executionContext] Optional execution context. Unused directly in this adapter.
     * @param {AbortSignal} [signal] Optional cancellation signal.
     * @returns {Promise<AIResponse<NormalizedEmbedding[]>>} Provider-normalized embedding artifacts.
     * @throws {Error} When input is invalid or Gemini returns no embeddings.
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
            model: merged.model ?? DEFAULT_GEMINI_EMBED_MODEL,
            contents: inputs.map((t) => ({ parts: [{ text: t }] })),
            config: {
                // TaskType is Gemini's unique feature.
                // It defaults to 'RETRIEVAL_QUERY' if not provided.
                taskType: merged.modelParams?.taskType || DEFAULT_GEMINI_EMBED_TASK_TYPE,
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
                metadata: buildMetadata(undefined, {
                    provider: AIProvider.Gemini,
                    model: merged.model,
                    status: "completed",
                    tokensUsed: (response as any)?.usageMetadata?.totalTokenCount,
                    requestId: context?.requestId
                })
            };
        });

        return {
            output: normalized,
            rawResponse: response,
            id: crypto.randomUUID(),
            metadata: buildMetadata(context?.metadata, {
                provider: AIProvider.Gemini,
                model: merged.model,
                status: "completed",
                tokensUsed: (response as any)?.usageMetadata?.totalTokenCount,
                requestId: context?.requestId
            })
        };
    }
}
