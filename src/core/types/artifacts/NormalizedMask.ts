/**
 * @module core/types/artifacts/NormalizedMask.ts
 * @description Core shared type definitions used by runtime, providers, and workflows.
 */
import { NormalizedArtifactBase } from "#root/index.js";

/**
 * @public
 * @description Data contract for NormalizedMask.
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
