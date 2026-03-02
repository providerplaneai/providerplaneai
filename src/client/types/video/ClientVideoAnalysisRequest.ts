import { ClientRequestBase } from "#root/index.js";

/**
 * Video reference passed to provider video-analysis capabilities.
 */
export interface ClientVideoInput {
    /** Optional caller-supplied id for correlating response rows. */
    id?: string;
    /** Video mime type (defaults to `video/mp4` when omitted). */
    mimeType?: string;
    /** Provider file URI / gs:// URI / downloadable URL. */
    url?: string;
    /** Inline base64 bytes for the video payload. */
    base64?: string;
}

/**
 * Provider-agnostic video analysis request.
 */
export interface ClientVideoAnalysisRequest extends ClientRequestBase {
    /** One or more videos to analyze. If omitted, provider may use context video artifacts. */
    videos?: ClientVideoInput[];
    /** Optional analysis instruction. */
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
