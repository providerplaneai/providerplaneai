/**
 * @module client/types/video/ClientVideoAnalysisRequest.ts
 * @description Provider-agnostic video analysis request contracts.
 */
import { ClientRequestBase } from "#root/index.js";

/**
 * Describes a video input supplied to a provider video-analysis request.
 *
 * @public
 */
export interface ClientVideoInput {
    /**
     * Optional caller-supplied id for correlating response rows.
     */
    id?: string;
    /**
     * Video mime type (defaults to `video/mp4` when omitted).
     */
    mimeType?: string;
    /**
     * Provider file URI / gs:// URI / downloadable URL.
     */
    url?: string;
    /**
     * Inline base64 bytes for the video payload.
     */
    base64?: string;
}

/**
 * Request payload for provider-agnostic video analysis.
 *
 * @public
 */
export interface ClientVideoAnalysisRequest extends ClientRequestBase {
    /**
     * One or more videos to analyze. If omitted, provider may use context video artifacts.
     */
    videos?: ClientVideoInput[];
    /**
     * Optional analysis instruction.
     */
    prompt?: string;
    params?: {
        model?: string;
        temperature?: number;
        maxOutputTokens?: number;
        /**
         * `json` asks the provider adapter to request structured JSON output.
         * Adapters still perform best-effort parsing because model output may drift.
         */
        outputFormat?: "text" | "json";
    };
}
