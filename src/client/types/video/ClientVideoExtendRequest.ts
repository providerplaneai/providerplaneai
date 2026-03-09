/**
 * @module client/types/video/ClientVideoExtendRequest.ts
 * @description ProviderPlaneAI source module.
 */
import { ClientRequestBase } from "#root/index.js";

/**
 * Provider-agnostic request for extending an existing video clip.
 */
/**
 * @public
 * @description Interface contract for ClientVideoExtendRequest.
 */
export interface ClientVideoExtendRequest extends ClientRequestBase {
    /**
     * Existing video URI or provider file reference to extend from.
     */
    sourceVideoUri?: string;
    /**
     * Optional base64-encoded source video content.
     */
    sourceVideoBase64?: string;
    /**
     * MIME type for base64 source video input.
     */
    sourceVideoMimeType?: string;
    /**
     * Optional text instruction for the extension behavior.
     */
    prompt?: string;

    /**
     * Optional extension and polling controls.
     */
    params?: {
        model?: string;
        /**
         * Gemini Veo currently accepts 4-8 seconds.
         */
        durationSeconds?: number;
        aspectRatio?: "16:9" | "9:16";
        resolution?: "720p" | "1080p";
        pollUntilComplete?: boolean;
        pollIntervalMs?: number;
        maxPollMs?: number;
        includeBase64?: boolean;
    };
}
