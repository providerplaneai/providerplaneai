/**
 * @module client/types/image/analysis/ImageAnalysisHints.ts
 * @description ProviderPlaneAI source module.
 */
/**
 * Advisory hints for image analysis.
 * Providers may partially or fully ignore these.
 */
/**
 * @public
 * @description Interface contract for ImageAnalysisHints.
 */
export interface ImageAnalysisHints {
    detectObjects?: boolean;
    extractText?: boolean;
    describeScene?: boolean;
    safetyAnalysis?: boolean;
}
