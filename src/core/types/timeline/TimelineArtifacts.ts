/**
 * @module core/types/timeline/TimelineArtifacts.ts
 * @description Timeline artifact container contract.
 */
import {
    NormalizedAudio,
    NormalizedChatMessage,
    NormalizedEmbedding,
    NormalizedFile,
    NormalizedImage,
    NormalizedImageAnalysis,
    NormalizedMask,
    NormalizedModeration,
    NormalizedOCRDocument,
    NormalizedVideo,
    NormalizedVideoAnalysis
} from "#root/index.js";

/**
 * Container for the artifact arrays that may be attached to a timeline event.
 *
 * @public
 */
export interface TimelineArtifacts {
    imageAnalysis?: NormalizedImageAnalysis[];
    ocr?: NormalizedOCRDocument[];
    videoAnalysis?: NormalizedVideoAnalysis[];
    images?: NormalizedImage[];
    masks?: NormalizedMask[];
    embeddings?: NormalizedEmbedding[];
    moderation?: NormalizedModeration[];
    chat?: NormalizedChatMessage[];
    transcript?: NormalizedChatMessage[];
    translation?: NormalizedChatMessage[];
    tts?: NormalizedAudio[];
    video?: NormalizedVideo[];
    files?: NormalizedFile[];
    custom?: Record<string, unknown>[];
}
