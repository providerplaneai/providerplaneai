import { ModerationResult, NormalizedImage, NormalizedImageAnalysis } from "#root/index.js";

/**
 * All valid timeline event types
 */
export type TimelineEventType =
    | "userMessage"
    | "assistantMessage"
    | "embedding"
    | "imageGeneration"
    | "imageEdit"
    | "imageAnalysis"
    | "moderation"
    | "systemEvent";

/**
 * Base interface for all timeline events
 */
export interface TimelineEventBase {
    id: string; // Unique UUID for this event
    type: TimelineEventType;
    timestamp: number; // Unix timestamp
    metadata?: Record<string, unknown>; // Optional extensible metadata
    artifacts: TimelineArtifacts;
}

/**
 * Events that can carry multimodal artifacts (images, audio, files)
 */
export interface UserMessageEvent extends TimelineEventBase {
    type: "userMessage";
    content: string | string[];
}

export interface AssistantMessageEvent extends TimelineEventBase {
    type: "assistantMessage";
    content: string | string[];
    rawResponse?: any; // Original provider response
}

/**
 * Other events have structured output fields; no generic artifacts
 */
export interface EmbeddingEvent extends TimelineEventBase {
    type: "embedding";
    vector: number[] | number[][];
}

export interface ImageGenerationEvent extends TimelineEventBase {
    type: "imageGeneration" | "imageEdit";
    images: NormalizedImage[];
}

export interface ImageAnalysisEvent extends TimelineEventBase {
    type: "imageAnalysis";
    analysis: NormalizedImageAnalysis[];
}

export interface ModerationEvent extends TimelineEventBase {
    type: "moderation";
    result: ModerationResult | ModerationResult[];
}

export interface SystemEvent extends TimelineEventBase {
    type: "systemEvent";
    message: string;
    details?: Record<string, unknown>;
}

/**
 * Union type for all timeline events
 */
export type TimelineEvent =
    | UserMessageEvent
    | AssistantMessageEvent
    | EmbeddingEvent
    | ImageGenerationEvent
    | ImageAnalysisEvent
    | ModerationEvent
    | SystemEvent;

/**
 * Artifacts type for multimodal data
 */
export interface TimelineArtifacts {
    images: NormalizedImage[];
    masks: NormalizedImage[];
    chat: string[];
    audioArtifacts: any[];
    videoArtifacts: any[];
    files: any[];
    [key: string]: unknown; // Allow for future extensibility
}
