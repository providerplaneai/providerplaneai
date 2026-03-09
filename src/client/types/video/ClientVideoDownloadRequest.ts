/**
 * @module client/types/video/ClientVideoDownloadRequest.ts
 * @description ProviderPlaneAI source module.
 */
import { ClientRequestBase } from "#root/index.js";

/**
 * Provider-agnostic request for downloading a generated video asset.
 */
/**
 * @public
 * @description Interface contract for ClientVideoDownloadRequest.
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
