import { NormalizedArtifactBase } from "#root/index.js";

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
