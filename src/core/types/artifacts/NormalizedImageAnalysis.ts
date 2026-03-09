/**
 * @module core/types/artifacts/NormalizedImageAnalysis.ts
 * @description Core shared type definitions used by runtime, providers, and workflows.
 */
import { DetectedObject, NormalizedArtifactBase, OCRText, SafetyRating } from "#root/index.js";

/**
 * Provider-agnostic normalized image analysis result.
 */
/**
 * @public
 * @description Data contract for NormalizedImageAnalysis.
 */
export interface NormalizedImageAnalysis extends NormalizedArtifactBase {
    /**
     * Optional natural language description.
     */
    description?: string;

    /**
     * Detected objects (if supported by provider).
     */
    objects?: DetectedObject[];

    /**
     * Extracted text (OCR).
     */
    text?: OCRText[];

    /**
     * Safety or moderation signals.
     */
    safety?: SafetyRating;

    /**
     * Tags or keywords inferred from the image.
     */
    tags?: string[];

    /**
     * The ID of the source image this analysis corresponds to.
     */
    sourceImageId?: string;
}
