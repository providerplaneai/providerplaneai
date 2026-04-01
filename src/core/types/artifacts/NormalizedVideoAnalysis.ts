/**
 * @module core/types/artifacts/NormalizedVideoAnalysis.ts
 * @description Normalized video-analysis artifact contracts.
 */
import { NormalizedArtifactBase } from "#root/index.js";

/**
 * @public
 * Timeline moment extracted from a normalized video-analysis result.
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
 * Provider-agnostic normalized video-analysis result.
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
