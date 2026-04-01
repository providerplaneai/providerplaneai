/**
 * @module core/types/artifacts/NormalizedImage.ts
 * @description Normalized image artifact contract.
 */
import { NormalizedArtifactBase } from "#root/index.js";

/**
 * Normalized representation of a generated or referenced image.
 * Includes both provider-specific raw data and normalized metadata.
 * Can be a URL or base64 content.
 */
/**
 * @public
 * Normalized representation of a generated or referenced image.
 */
export interface NormalizedImage extends NormalizedArtifactBase {
    base64?: string;
    url?: string;
    mimeType: string;
    width?: number;
    height?: number;
    index?: number;
}
