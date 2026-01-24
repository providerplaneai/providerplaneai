import { DetectedObject, OCRText, SafetyRating } from "#root/index.js";

/**
 * Provider-agnostic normalized image analysis result.
 */
export interface NormalizedImageAnalysis {
    /**
     * Id of the image this analysis refers to.
     * Matches ClientReferenceImage.id.
     */
    id: string;

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
     * Raw provider response (escape hatch).
     */
    raw?: unknown;
}
