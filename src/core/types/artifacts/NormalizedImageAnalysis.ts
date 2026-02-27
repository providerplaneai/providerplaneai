import { DetectedObject, NormalizedArtifactBase, OCRText, SafetyRating } from "#root/index.js";

/**
 * Provider-agnostic normalized image analysis result.
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
