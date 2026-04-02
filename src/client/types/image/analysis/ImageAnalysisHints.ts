/**
 * @module client/types/image/analysis/ImageAnalysisHints.ts
 * @description Client-facing request and helper types.
 */
/**
 * Advisory hints for image analysis.
 * Providers may partially or fully ignore these.
 */
/**
 * Optional hints that steer provider image-analysis behavior without changing the core prompt.
 *
 * @public
 */
export interface ImageAnalysisHints {
    detectObjects?: boolean;
    extractText?: boolean;
    describeScene?: boolean;
    safetyAnalysis?: boolean;
}
