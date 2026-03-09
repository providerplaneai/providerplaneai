/**
 * @module core/types/artifacts/NormalizedVideoAnalysis.ts
 * @description Core shared type definitions used by runtime, providers, and workflows.
 */
import { NormalizedArtifactBase } from "#root/index.js";

/**
 * @public
 * @description Data contract for NormalizedVideoMoment.
 */
export interface NormalizedVideoMoment {
    timestampSeconds?: number;
    text: string;
}

/**
 * Provider-agnostic normalized video analysis result.
 */
/**
 * @public
 * @description Data contract for NormalizedVideoAnalysis.
 */
export interface NormalizedVideoAnalysis extends NormalizedArtifactBase {
    /**
     * High-level summary of the video content.
     */
    summary?: string;
    /**
     * Optional extracted transcript/captions from the analyzed video.
     */
    transcript?: string;
    /**
     * Optional topical tags inferred by the model.
     */
    tags?: string[];
    /**
     * Optional timeline highlights/events.
     */
    moments?: NormalizedVideoMoment[];
    /**
     * Source video id this analysis corresponds to when known.
     */
    sourceVideoId?: string;
}
