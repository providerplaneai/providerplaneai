/**
 * Advisory hints for image analysis.
 * Providers may partially or fully ignore these.
 */
export interface ImageAnalysisHints {
    detectObjects?: boolean;
    extractText?: boolean;
    describeScene?: boolean;
    safetyAnalysis?: boolean;
}
