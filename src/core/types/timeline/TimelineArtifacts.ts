import {
    NormalizedAudio,
    NormalizedChatMessage,
    NormalizedEmbedding,
    NormalizedFile,
    NormalizedImage,
    NormalizedImageAnalysis,
    NormalizedMask,
    NormalizedModeration,
    NormalizedVideo,
    NormalizedVideoAnalysis
} from "#root/index.js";

/**
 * TimelineArtifacts represents the various types of artifacts that can be produced during a timeline execution.
 * It is designed to be flexible and extensible, allowing for different types of artifacts to be added as needed.
 */
export interface TimelineArtifacts {
    analysis?: (NormalizedImageAnalysis | NormalizedVideoAnalysis)[];
    images?: NormalizedImage[];
    masks?: NormalizedMask[];
    embeddings?: NormalizedEmbedding[];
    moderation?: NormalizedModeration[];
    chat?: NormalizedChatMessage[];
    audio?: NormalizedAudio[];
    video?: NormalizedVideo[];
    files?: NormalizedFile[];
    custom?: Record<string, unknown>[];
}
