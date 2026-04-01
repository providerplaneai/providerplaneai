/**
 * @module providers/anthropic/capabilities/AnthropicEmbedCapabilityImpl.ts
 * @description Anthropic embedding capability adapter backed by Voyage AI.
 */
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

const DEFAULT_ANTHROPIC_EMBED_MODEL = "voyage-3";

/**
 * Typed representation of the Voyage AI embeddings API response.
 *
 * This is intentionally minimal and only includes fields required for normalization and metadata reporting.
 */
interface VoyageEmbeddingResponse {
    object: string;
    data: Array<{
        object: string;
        embedding: number[];
        index: number;
    }>;
    model: string;
    usage: {
        total_tokens: number;
    };
}

/**
 * Adapts Anthropic embeddings into ProviderPlaneAI by proxying requests to Voyage AI.
 *
 * Anthropic does not currently expose a native embeddings endpoint, so this
 * capability uses Voyage AI while preserving Anthropic as the normalized provider.
 *
 * @public
 */
export class AnthropicEmbedCapabilityImpl implements EmbedCapability<ClientEmbeddingRequest, NormalizedEmbedding[]> {
    /**
     * Voyage AI API key used for proxied embedding requests.
     */
    private readonly voyageApiKey: string;
    /**
     * Base URL for the Voyage AI REST API.
     */
    private readonly voyageBaseUrl: string = "https://api.voyageai.com/v1";

    /**
     * Creates a new Anthropic embedding capability adapter.
     *
     * @param {BaseProvider} provider Parent provider instance used for lifecycle validation and option resolution.
     * @throws {Error} When `VOYAGE_API_KEY` is not configured.
     */
    constructor(private readonly provider: BaseProvider) {
        // Get Voyage API key from environment variable
        this.voyageApiKey = process.env.VOYAGE_API_KEY ?? "";

        if (!this.voyageApiKey) {
            throw new Error(
                `Voyage AI API key is required for Anthropic embeddings. 
                 Set VOYAGE_API_KEY environment variable or pass it to the constructor.`
            );
        }
    }

    /**
     * Executes a Voyage-backed embedding request for Anthropic.
     *
     * Responsibilities:
     * - validate embedding input
     * - resolve merged model/runtime options
     * - normalize scalar input into Voyage's array-based request shape
     * - execute the HTTP request and normalize returned vectors
     * - attach Anthropic-facing metadata plus the underlying embedding provider
     *
     * @param {AIRequest<ClientEmbeddingRequest>} request Unified embedding request envelope.
     * @param {MultiModalExecutionContext} [_executionContext] Optional execution context. Unused directly in this adapter.
     * @param {AbortSignal} [signal] Optional cancellation signal.
     * @returns {Promise<AIResponse<NormalizedEmbedding[]>>} Provider-normalized embedding artifacts.
     * @throws {Error} When input is invalid, aborted, or Voyage AI returns an error.
     */
    async embed(
        request: AIRequest<ClientEmbeddingRequest>,
        _executionContext?: MultiModalExecutionContext,
        signal?: AbortSignal
    ): Promise<AIResponse<NormalizedEmbedding[]>> {
        // Ensure provider lifecycle has completed (init was called)
        this.provider.ensureInitialized();

        const { input, options, context } = request;
        // Defensive validation: Voyage requires at least one input string
        if (!input?.input) {
            throw new Error("Invalid embedding input");
        }

        if (signal?.aborted) {
            throw new Error("Request aborted");
        }

        // Merge general, provider, model, and request-level options
        const merged = this.provider.getMergedOptions(CapabilityKeys.EmbedCapabilityKey, options);

        /**
         * Normalize input to array for API call.
         *
         * Voyage API expects an array of inputs.
         * We normalize single-string input to array form
         * and later restore the original shape.
         */
        const inputs = Array.isArray(input.input) ? input.input : [input.input];

        // Call Voyage AI embeddings API
        const response = await fetch(`${this.voyageBaseUrl}/embeddings`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${this.voyageApiKey}`
            },
            body: JSON.stringify({
                input: inputs,
                model: merged.model ?? DEFAULT_ANTHROPIC_EMBED_MODEL,
                ...(merged.modelParams ?? {}),
                ...(merged.providerParams ?? {})
            }),
            signal
        });

        // Explicit error handling to surface provider errors
        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Voyage AI API error: ${response.status} - ${errorText}`);
        }

        const voyageResponse: VoyageEmbeddingResponse = await response.json();
        if (!voyageResponse.data || voyageResponse.data.length === 0) {
            throw new Error("Voyage AI returned no embeddings");
        }

        /**
         * Ensure deterministic ordering.
         * Fast-path contiguous/unique indices to avoid sort allocations;
         * fallback to defensive sort when provider indices are sparse/out of order.
         */
        const indexedVectors: Array<number[] | undefined> = new Array(voyageResponse.data.length);
        let canUseIndexedFastPath = true;
        for (const item of voyageResponse.data) {
            const idx = item.index;
            if (!Number.isInteger(idx) || idx < 0 || idx >= indexedVectors.length || indexedVectors[idx] !== undefined) {
                canUseIndexedFastPath = false;
                break;
            }
            indexedVectors[idx] = item.embedding;
        }

        const vectors = canUseIndexedFastPath
            ? (indexedVectors as number[][])
            : [...voyageResponse.data].sort((a, b) => a.index - b.index).map((d) => d.embedding);

        // Map to NormalizedEmbedding[]
        const normalized: NormalizedEmbedding[] = vectors.map((vector, _idx) => ({
            id: crypto.randomUUID(),
            vector,
            dimensions: vector.length,
            inputId: Array.isArray(input.input) ? undefined : (input as any).inputId,
            purpose: (request as any)?.purpose ?? "embedding",
            metadata: buildMetadata(undefined, {
                provider: AIProvider.Anthropic,
                model: merged.model ?? voyageResponse.model,
                status: "completed",
                tokensUsed: voyageResponse.usage?.total_tokens,
                requestId: context?.requestId,
                embeddingProvider: "voyage-ai"
            })
        }));

        // Return a fully normalized response
        return {
            output: Array.isArray(input.input) ? normalized : normalized[0] ? [normalized[0]] : [],
            rawResponse: voyageResponse,
            metadata: buildMetadata(context?.metadata, {
                provider: AIProvider.Anthropic,
                model: merged.model ?? voyageResponse.model,
                status: "completed",
                tokensUsed: voyageResponse.usage?.total_tokens,
                requestId: context?.requestId,
                embeddingProvider: "voyage-ai" // Track that we used Voyage AI
            })
        };
    }
}
