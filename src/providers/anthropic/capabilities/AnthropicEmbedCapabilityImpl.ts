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

const DEFAULT_ANTHROPIC_EMBED_MODEL = "voyage-3";

/**
 * Typed representation of Voyage AI embeddings API response (used for Anthropic embeddings).
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
 * AnthropicEmbedCapabilityImpl: Implements embedding capability for Anthropic via Voyage AI.
 *
 * Anthropic does not natively provide embeddings; this class proxies requests to Voyage AI.
 *
 * - Implements the unified IEmbedCapability interface
 * - Transparently proxies embedding requests to Voyage AI
 * - Normalizes the response into ProviderPlaneAI's AIResponse format
 * - Preserves provider identity as "Anthropic" for consistency
 *
 * @template TEmbedInput
 * @template TEmbedOutput
 */
export class AnthropicEmbedCapabilityImpl implements EmbedCapability<ClientEmbeddingRequest, NormalizedEmbedding[]> {
    /** Voyage AI API key (required) */
    private readonly voyageApiKey: string;
    /** Base URL for Voyage AI REST API */
    private readonly voyageBaseUrl: string = "https://api.voyageai.com/v1";

    /**
     * Creates a new Anthropic embedding capability.
     *
     * @param provider - Parent provider instance used for lifecycle validation
     * @throws Error if VOYAGE_API_KEY is missing
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
     * Generates embeddings for one or more input strings.
     *
     * Responsibilities:
     * - Validate input
     * - Initialize capability execution context
     * - Normalize input shape for Voyage API
     * - Execute HTTP request
     * - Normalize response shape
     * - Attach metadata and error handling
     *
     * @template TEmbedInput
     * @param request - Unified embedding request
     * @param _executionContext Optional execution context
     * @param signal Optional abort signal
     * @returns AIResponse containing a single vector or array of vectors
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
         * Voyage returns index fields but we do not assume order.
         */
        const vectors = voyageResponse.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);

        // Map to NormalizedEmbedding[]
        const normalized: NormalizedEmbedding[] = vectors.map((vector, _idx) => ({
            id: crypto.randomUUID(),
            vector,
            dimensions: vector.length,
            inputId: Array.isArray(input.input) ? undefined : (input as any).inputId,
            purpose: (request as any)?.purpose ?? "embedding",
            metadata: {
                provider: AIProvider.Anthropic,
                model: merged.model ?? voyageResponse.model,
                status: "completed",
                tokensUsed: voyageResponse.usage?.total_tokens,
                requestId: context?.requestId,
                embeddingProvider: "voyage-ai"
            }
        }));

        // Return a fully normalized response
        return {
            output: Array.isArray(input.input) ? normalized : normalized[0] ? [normalized[0]] : [],
            rawResponse: voyageResponse,
            metadata: {
                ...(context?.metadata ?? {}),
                provider: AIProvider.Anthropic,
                model: merged.model ?? voyageResponse.model,
                status: "completed",
                tokensUsed: voyageResponse.usage?.total_tokens,
                requestId: context?.requestId,
                embeddingProvider: "voyage-ai" // Track that we used Voyage AI
            }
        };
    }
}
