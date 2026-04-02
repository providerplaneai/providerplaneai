/**
 * @module client/types/image/analysis/ClientImageAnalysisRequest.ts
 * @description Client-facing request and helper types.
 */
import { ClientReferenceImage, ImageAnalysisFeatures, ImageAnalysisHints } from "#root/index.js";

/**
 * Request payload for provider-agnostic image analysis and vision tasks.
 *
 * @public
 */
export interface ClientImageAnalysisRequest {
    /**
     * One or more images to analyze
     */
    images?: ClientReferenceImage[];

    /**
     * Optional instruction to guide analysis.
     * Example: "Describe the scene and identify safety risks."
     */
    prompt?: string;
    /**
     * Requested analysis features
     */
    features?: ImageAnalysisFeatures;

    /**
     * Optional structured analysis hints.
     * Providers may ignore unsupported hints.
     */
    hints?: ImageAnalysisHints;
    /**
     * Provider escape hatch
     */
    extras?: Record<string, unknown>;
}
