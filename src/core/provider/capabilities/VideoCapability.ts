import { AIRequest, AIResponse, MultiModalExecutionContext, NormalizedVideo, ProviderCapability } from "#root/index.js";

/**
 * Provider-agnostic video generation capability.
 */
export interface VideoGenerationCapability<TInput = unknown, TOutput = NormalizedVideo[]> extends ProviderCapability {
    /**
     * Generate video output from a request prompt and optional provider-specific params.
     *
     * @param request Unified AI request
     * @param ctx Execution context
     * @param signal Optional abort signal
     */
    generateVideo(
        request: AIRequest<TInput>,
        ctx: MultiModalExecutionContext,
        signal?: AbortSignal
    ): Promise<AIResponse<TOutput>>;
}

/**
 * Provider-agnostic video remix capability.
 */
export interface VideoRemixCapability<TInput = unknown, TOutput = NormalizedVideo[]> extends ProviderCapability {
    /**
     * Remix an existing provider video using a new prompt.
     *
     * @param request Unified AI request
     * @param ctx Execution context
     * @param signal Optional abort signal
     */
    remixVideo(request: AIRequest<TInput>, ctx: MultiModalExecutionContext, signal?: AbortSignal): Promise<AIResponse<TOutput>>;
}

/**
 * Provider-agnostic video download capability.
 */
export interface VideoDownloadCapability<TInput = unknown, TOutput = NormalizedVideo[]> extends ProviderCapability {
    /**
     * Download video bytes or related rendered assets for an existing provider video id.
     *
     * @param request Unified AI request
     * @param ctx Execution context
     * @param signal Optional abort signal
     */
    downloadVideo(
        request: AIRequest<TInput>,
        ctx: MultiModalExecutionContext,
        signal?: AbortSignal
    ): Promise<AIResponse<TOutput>>;
}

/**
 * Provider-agnostic video extension capability.
 */
export interface VideoExtendCapability<TInput = unknown, TOutput = NormalizedVideo[]> extends ProviderCapability {
    /**
     * Extend an existing video clip.
     *
     * @param request Unified AI request
     * @param ctx Execution context
     * @param signal Optional abort signal
     */
    extendVideo(
        request: AIRequest<TInput>,
        ctx: MultiModalExecutionContext,
        signal?: AbortSignal
    ): Promise<AIResponse<TOutput>>;
}

/**
 * Provider-agnostic video analysis capability.
 */
export interface VideoAnalysisCapability<TInput = unknown, TOutput = unknown> extends ProviderCapability {
    /**
     * Analyze an existing video and return structured analysis output.
     *
     * @param request Unified AI request
     * @param ctx Execution context
     * @param signal Optional abort signal
     */
    analyzeVideo(
        request: AIRequest<TInput>,
        ctx: MultiModalExecutionContext,
        signal?: AbortSignal
    ): Promise<AIResponse<TOutput>>;
}
