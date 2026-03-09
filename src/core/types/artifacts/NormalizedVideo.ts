/**
 * @module core/types/artifacts/NormalizedVideo.ts
 * @description Core shared type definitions used by runtime, providers, and workflows.
 */
import { NormalizedArtifactBase } from "#root/index.js";

/**
 * Normalized representation of any video output produced by a provider.
 *
 * Examples:
 * - Video generation models
 * - Vision model outputs
 * - Tool-produced videos
 */
/**
 * @public
 * @description Data contract for NormalizedVideo.
 */
export interface NormalizedVideo extends NormalizedArtifactBase {
    /**
     * MIME type (e.g. video/mp4, video/webm)
     */
    mimeType: string;
    /**
     * Public or signed URL to the video
     */
    url?: string;
    /**
     * Base64-encoded video data (rare but supported)
     */
    base64?: string;
    /**
     * Video width in pixels
     */
    width?: number;
    /**
     * Video height in pixels
     */
    height?: number;
    /**
     * Duration in seconds
     */
    durationSeconds?: number;
    /**
     * Frame rate (fps) if known
     */
    frameRate?: number;
}
