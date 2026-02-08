import { NormalizedArtifactBase } from "#root/index.js";

/**
 * Provider-agnostic moderation result for a SINGLE input string.
 */
export interface NormalizedModeration extends NormalizedArtifactBase {
    /**
     * Whether THIS input was flagged.
     */
    flagged: boolean;

    /**
     * Categories for THIS input.
     */
    categories: Record<string, boolean>;

    /**
     * Confidence scores for THIS input.
     */
    categoryScores?: Record<string, number>;

    /**
     * Human-readable explanation (derived, not aggregated).
     */
    reason?: string;

    /**
     * Index of the input in the original request (batch-safe).
     */
    inputIndex?: number;
}
