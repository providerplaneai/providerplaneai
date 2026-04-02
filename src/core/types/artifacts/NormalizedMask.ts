/**
 * @module core/types/artifacts/NormalizedMask.ts
 * @description Normalized mask artifact contract used by image-editing workflows.
 */
import { NormalizedArtifactBase } from "#root/index.js";

/**
 * @public
 * Provider-agnostic mask artifact.
 */
export interface NormalizedMask extends NormalizedArtifactBase {
    /**
     * Mask image data
     */
    url?: string;
    base64?: string;

    /**
     * Optional linkage to the image it applies to
     */
    targetImageId?: string;

    /**
     * Mask semantics (provider-agnostic)
     */
    kind?: "alpha" | "binary" | "grayscale";
}
