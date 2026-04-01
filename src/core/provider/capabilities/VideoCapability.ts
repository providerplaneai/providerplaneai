/**
 * @module core/provider/capabilities/VideoCapability.ts
 * @description Provider-agnostic video capability interface contracts.
 */
import { AIRequest, AIResponse, MultiModalExecutionContext, NormalizedVideo, ProviderCapability } from "#root/index.js";

/**
 * Provider-agnostic video generation capability contract.
 *
 * @public
 */
export interface VideoGenerationCapability<TInput = unknown, TOutput = NormalizedVideo[]> extends ProviderCapability {
    /**
     * Generate video output from a request prompt and optional provider-specific params.
     *
     * @param {AIRequest<TInput>} request - Unified AI request.
     * @param {MultiModalExecutionContext} ctx - Execution context.
     * @param {AbortSignal | undefined} signal - Optional abort signal.
     * @returns {Promise<AIResponse<TOutput>>} Promise resolving to normalized generated video artifacts.
     */
    generateVideo(
        request: AIRequest<TInput>,
        ctx: MultiModalExecutionContext,
        signal?: AbortSignal
    ): Promise<AIResponse<TOutput>>;
}

/**
 * Provider-agnostic video remix capability contract.
 *
 * @public
 */
export interface VideoRemixCapability<TInput = unknown, TOutput = NormalizedVideo[]> extends ProviderCapability {
    /**
     * Remix an existing provider video using a new prompt.
     *
     * @param {AIRequest<TInput>} request - Unified AI request.
     * @param {MultiModalExecutionContext} ctx - Execution context.
     * @param {AbortSignal | undefined} signal - Optional abort signal.
     * @returns {Promise<AIResponse<TOutput>>} Promise resolving to normalized remixed video artifacts.
     */
    remixVideo(request: AIRequest<TInput>, ctx: MultiModalExecutionContext, signal?: AbortSignal): Promise<AIResponse<TOutput>>;
}

/**
 * Provider-agnostic video download capability contract.
 *
 * @public
 */
export interface VideoDownloadCapability<TInput = unknown, TOutput = NormalizedVideo[]> extends ProviderCapability {
    /**
     * Download video bytes or related rendered assets for an existing provider video id.
     *
     * @param {AIRequest<TInput>} request - Unified AI request.
     * @param {MultiModalExecutionContext} ctx - Execution context.
     * @param {AbortSignal | undefined} signal - Optional abort signal.
     * @returns {Promise<AIResponse<TOutput>>} Promise resolving to downloaded video artifacts.
     */
    downloadVideo(
        request: AIRequest<TInput>,
        ctx: MultiModalExecutionContext,
        signal?: AbortSignal
    ): Promise<AIResponse<TOutput>>;
}

/**
 * Provider-agnostic video extension capability contract.
 *
 * @public
 */
export interface VideoExtendCapability<TInput = unknown, TOutput = NormalizedVideo[]> extends ProviderCapability {
    /**
     * Extend an existing video clip.
     *
     * @param {AIRequest<TInput>} request - Unified AI request.
     * @param {MultiModalExecutionContext} ctx - Execution context.
     * @param {AbortSignal | undefined} signal - Optional abort signal.
     * @returns {Promise<AIResponse<TOutput>>} Promise resolving to normalized extended video artifacts.
     */
    extendVideo(
        request: AIRequest<TInput>,
        ctx: MultiModalExecutionContext,
        signal?: AbortSignal
    ): Promise<AIResponse<TOutput>>;
}

/**
 * Provider-agnostic video analysis capability contract.
 *
 * @public
 */
export interface VideoAnalysisCapability<TInput = unknown, TOutput = unknown> extends ProviderCapability {
    /**
     * Analyze an existing video and return structured analysis output.
     *
     * @param {AIRequest<TInput>} request - Unified AI request.
     * @param {MultiModalExecutionContext} ctx - Execution context.
     * @param {AbortSignal | undefined} signal - Optional abort signal.
     * @returns {Promise<AIResponse<TOutput>>} Promise resolving to provider-normalized video analysis output.
     */
    analyzeVideo(
        request: AIRequest<TInput>,
        ctx: MultiModalExecutionContext,
        signal?: AbortSignal
    ): Promise<AIResponse<TOutput>>;
}
