/**
 * @module client/types/video/ClientVideoDownloadRequest.ts
 * @description Client-facing request and helper types.
 */
import { ClientRequestBase } from "#root/index.js";

/**
 * Request payload for downloading a previously generated video asset.
 *
 * @public
 */
export interface ClientVideoDownloadRequest extends ClientRequestBase {
    /**
     * Provider video id to download (OpenAI-style).
     */
    videoId?: string;
    /**
     * Video URI or provider file reference (Gemini-style).
     */
    videoUri?: string;
    /**
     * Which downloadable asset to fetch. Defaults to `video`.
     */
    variant?: "video" | "thumbnail" | "spritesheet";
}
