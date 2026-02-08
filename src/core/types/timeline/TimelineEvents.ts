import { NormalizedChatMessage, NormalizedUserInput, TimelineArtifacts } from "#root/index.js";

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
    | "audio"
    | "video"
    | "file"
    | "systemEvent";

/**
 * Base interface for all timeline events
 */
export interface TimelineEventBase {
    id: string; // Unique UUID for this event
    type: TimelineEventType;
    timestamp: number; // Unix timestamp    
    artifacts: TimelineArtifacts;
    /**
     * Optional, inert execution metadata
     * NEVER used automatically
     */
    metadata?: {
        provider?: string;
        model?: string;
        requestId?: string;
        [key: string]: unknown;
    };
}

/**
 * User message event (input from user)
 */
export interface UserMessageEvent extends TimelineEventBase {
    type: "userMessage";
    /**
     * Canonical user message for this turn
     * (usually exactly one NormalizedUserInput)
     */
    message: NormalizedUserInput;
}

/**
 * Assistant message event (model output)
 */
export interface AssistantMessageEvent extends TimelineEventBase {
    type: "assistantMessage";
    /**
     * Canonical assistant reply for this turn
     */
    message: NormalizedChatMessage;
}

/**
 * System / internal event
 */
export interface SystemEvent extends TimelineEventBase {
    type: "systemEvent";

    /**
     * Machine-readable system action
     */
    action:
        | "attachArtifacts"
        | "providerFallback"
        | "streamChunk"
        | "debug"
        | "internal";

    /**
     * Optional human-readable description
     */
    message?: string;

    /**
     * Structured details for debugging or introspection
     */
    details?: Record<string, unknown>;
}

/**
 * Artifact-only events (no dedicated structured output fields)
 * Everything lives in TimelineArtifacts now
 */
export interface EmbeddingEvent extends TimelineEventBase {
    type: "embedding";
}

export interface ImageGenerationEvent extends TimelineEventBase {
    type: "imageGeneration";
}

export interface ImageEditEvent extends TimelineEventBase {
    type: "imageEdit";
}

export interface ImageAnalysisEvent extends TimelineEventBase {
    type: "imageAnalysis";
}

export interface ModerationEvent extends TimelineEventBase {
    type: "moderation";
}

export interface AudioEvent extends TimelineEventBase {
    type: "audio";
}

export interface VideoEvent extends TimelineEventBase {
    type: "video";
}

export interface FileEvent extends TimelineEventBase {
    type: "file";
}

/**
 * Union type for all timeline events
 */
export type TimelineEvent =
    | UserMessageEvent
    | AssistantMessageEvent
    | SystemEvent
    | EmbeddingEvent
    | ImageEditEvent
    | ImageGenerationEvent
    | ImageAnalysisEvent
    | ModerationEvent
    | AudioEvent
    | VideoEvent
    | FileEvent;