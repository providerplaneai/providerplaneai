import { 
    NormalizedAudio, 
    NormalizedChatMessage, 
    NormalizedEmbedding, 
    NormalizedFile, 
    NormalizedImage, 
    NormalizedImageAnalysis, 
    NormalizedMask, 
    NormalizedModeration, 
    NormalizedVideo 
} from "#root/index.js";

export interface TimelineArtifacts {
    analysis?: NormalizedImageAnalysis[];
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
