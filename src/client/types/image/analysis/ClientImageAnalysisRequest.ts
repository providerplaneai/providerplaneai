/**
 * @module client/types/image/analysis/ClientImageAnalysisRequest.ts
 * @description ProviderPlaneAI source module.
 */
import { ClientReferenceImage, ImageAnalysisFeatures, ImageAnalysisHints } from "#root/index.js";

/**
 * Provider-agnostic image analysis request. Used by all vision-capable providers (OpenAI, Gemini, etc.).
 *
 * Used for vision-based understanding tasks such as:
 * - Image description
 * - Object detection
 * - OCR
 * - Safety analysis
 * - Structured scene understanding
 */
/**
 * @public
 * @description Interface contract for ClientImageAnalysisRequest.
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
