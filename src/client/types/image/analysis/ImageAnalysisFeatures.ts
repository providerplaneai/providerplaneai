/**
 * @module client/types/image/analysis/ImageAnalysisFeatures.ts
 * @description ProviderPlaneAI source module.
 */
/**
 * Feature flags controlling which analysis outputs are requested.
 *
 * Providers may ignore unsupported features.
 */
/**
 * @public
 * @description Interface contract for ImageAnalysisFeatures.
 */
export interface ImageAnalysisFeatures {
    /**
     * Natural language description of the image
     */
    description?: boolean;
    /**
     * Object and entity detection
     */
    objects?: boolean;
    /**
     * Optical character recognition
     */
    text?: boolean;
    /**
     * Safety / content risk assessment
     */
    safety?: boolean;
    /**
     * Bounding boxes for detected entities
     */
    boundingBoxes?: boolean;
    /**
     * Model-specific advanced analysis
     */
    extras?: Record<string, unknown>;
}
