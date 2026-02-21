import {
    AIRequest,
    AIResponse,
    AIResponseChunk,
    ClientImageGenerationRequest,
    MultiModalExecutionContext,
    NormalizedImage,
    NormalizedImageAnalysis,
    ProviderCapability
} from "#root/index.js";

/**
 * Provider-agnostic image generation capability interface.
 *
 * Providers that implement this interface can generate images from prompts.
 *
 * @template TInput Input type for image generation request
 * @template TOutput Output type (array of normalized images)
 */
export interface ImageGenerationCapability<
    TInput = ClientImageGenerationRequest,
    TOutput = NormalizedImage[]
> extends ProviderCapability {
    /**
     * Generate images for the given request.
     *
     * @param req AIRequest containing image generation input
     * @param ctx Execution context
     * @returns AIResponse wrapping generated images
     */
    generateImage(req: AIRequest<TInput>, ctx: MultiModalExecutionContext, signal?: AbortSignal): Promise<AIResponse<TOutput>>;
}

/**
 * Provider-agnostic streaming image generation capability interface.
 *
 * Allows receiving partial image data streams.
 *
 * @template TInput Input type for image generation request
 * @template TOutput Output type (partial chunks or final image data)
 */
export interface ImageGenerationStreamCapability<TInput = any, TOutput = NormalizedImage[]> extends ProviderCapability {
    /**
     * Stream image generation results as they are produced.
     *
     * @param request AIRequest containing image generation input
     * @param ctx Execution context
     * @returns AsyncGenerator yielding AIResponseChunk objects
     */
    generateImageStream(
        request: AIRequest<TInput>,
        ctx: MultiModalExecutionContext,
        signal?: AbortSignal
    ): AsyncGenerator<AIResponseChunk<TOutput>>;
}

/**
 * Capability interface for image analysis / vision understanding.
 *
 * Image analysis includes tasks such as:
 * - Image captioning / description
 * - Object detection
 * - OCR (text extraction)
 * - Safety / content classification
 * - Tagging or labeling
 *
 * This interface is intentionally provider-agnostic.
 * Each provider (OpenAI, Gemini, Anthropic, etc.) is responsible
 * for mapping its native vision APIs into the normalized output type.
 *
 * @template TInput Input type for image analysis request
 * @template TOutput Output type (partial chunks or final data)
 */
export interface ImageAnalysisCapability<TInput = unknown, TOutput = NormalizedImageAnalysis[]> extends ProviderCapability {
    /**
     * Analyze one or more images and return structured, normalized results.
     *
     * @param request AIRequest containing image generation input
     * @param ctx Execution context
     * @returns A normalized AIResponse containing image analysis results.
     */
    analyzeImage(
        request: AIRequest<TInput>,
        ctx: MultiModalExecutionContext,
        signal?: AbortSignal
    ): Promise<AIResponse<TOutput>>;
}

/**
 * Streaming image analysis capability.
 *
 * Providers implementing this interface support analyzing one or more
 * images and emitting structured, provider-agnostic analysis results
 * incrementally as they become available.
 *
 * Typical use cases:
 * - Vision analysis with object detection
 * - OCR extraction
 * - Safety / moderation signals
 * - Tagging and semantic classification
 *
 * @template TImageAnalysisInput - Provider-agnostic image analysis request type
 */
export interface ImageAnalysisStreamCapability<
    TInput = unknown,
    TOutput = NormalizedImageAnalysis[]
> extends ProviderCapability {
    /**
     * Analyze images with streaming output.
     *
     * The returned async iterable yields objects as
     * soon as partial or completed analysis results are available.
     *
     * @template TInput Input type for image analysis request
     * @template TOutput Output type (partial chunks or final data)
     */
    analyzeImageStream(
        request: AIRequest<TInput>,
        ctx: MultiModalExecutionContext,
        signal?: AbortSignal
    ): AsyncGenerator<AIResponseChunk<TOutput>>;
}

/**
 * Image editing capability (non-streaming).
 *
 * Represents the ability to perform image edits using one or more
 * reference images and an edit prompt.
 *
 * Image editing is modeled as a first-class capability, distinct from
 * image generation, but shares the same normalization surface
 * (`NormalizedImage[]`).
 *
 * Semantics:
 * - One or more reference images are provided via the request input
 * - Reference image roles (e.g. "reference", "mask", "style") determine
 *   how the provider interprets them
 * - The provider is responsible for mapping these semantics to its
 *   underlying API (e.g. OpenAI Responses API image editing)
 *
 * This method:
 * - Executes a single edit operation
 * - Returns the fully materialized edited image(s)
 * - Does not stream intermediate results
 *
 * @template TRequest - Client-specific image edit request shape
 */
export interface ImageEditCapability<TInput = unknown, TOutput = NormalizedImage[]> extends ProviderCapability {
    /**
     * Performs an image edit operation.
     *
     * @param request - Unified AI request containing:
     *   - edit prompt
     *   - reference images (base image, mask, style, etc.)
     *   - optional provider/model parameters
     * @param ctx Execution context
     * @returns Promise resolving to an AIResponse containing normalized images
     */
    editImage(request: AIRequest<TInput>, ctx: MultiModalExecutionContext, signal?: AbortSignal): Promise<AIResponse<TOutput>>;
}

/**
 * Streaming image editing capability.
 *
 * Represents the ability to perform image edits while streaming
 * partial or incremental results.
 *
 * Streaming image editing is designed for:
 * - multi-turn or iterative edits
 * - progressive refinement
 * - long-running or expensive edit operations
 *
 * This interface mirrors the streaming semantics of chat and
 * image generation capabilities.
 *
 * @template TRequest - Client-specific image edit request shape
 */
export interface ImageEditStreamCapability<TInput = unknown, TOutput = NormalizedImage[]> extends ProviderCapability {
    /**
     * Performs a streaming image edit operation.
     *
     * @param request - Unified AI request containing:
     *   - edit prompt
     *   - reference images (base image, mask, style, etc.)
     *   - optional provider/model parameters
     * @param ctx Execution context
     * @returns AsyncGenerator yielding AIResponseChunk objects containing partial or complete normalized images
     */
    editImageStream(
        request: AIRequest<TInput>,
        ctx: MultiModalExecutionContext,
        signal?: AbortSignal
    ): AsyncGenerator<AIResponseChunk<TOutput>>;
}
