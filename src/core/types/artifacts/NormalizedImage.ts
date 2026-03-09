/**
 * @module core/types/artifacts/NormalizedImage.ts
 * @description Core shared type definitions used by runtime, providers, and workflows.
 */
import { NormalizedArtifactBase } from "#root/index.js";

/**
 * Normalized representation of a generated or referenced image.
 * Includes both provider-specific raw data and normalized metadata.
 * Can be a URL or base64 content.
 */
/**
 * @public
 * @description Data contract for NormalizedImage.
 */
export interface NormalizedImage extends NormalizedArtifactBase {
    base64?: string;
    url?: string;
    mimeType: string;
    width?: number;
    height?: number;
    index?: number;
}
