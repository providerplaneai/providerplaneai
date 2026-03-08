import { NormalizedChatMessage, NormalizedUserInput, TimelineArtifacts } from "#root/index.js";

/**
 * All valid timeline event types
 */
export type TimelineEventType =
    | "userMessage"
    | "assistantMessage"
    | "systemEvent"
    | "chat"
    | "embedding"
    | "moderation"
    | "imageGeneration"
    | "imageEdit"
    | "imageAnalysis"
    | "videoGeneration"
    | "videoEdit"
    | "videoAnalysis"
    | "videoDownload"
    | "transcript"
    | "translation"
    | "tts"
    | "file"
    | "custom";

/**
 * Base interface for all timeline events
 *
 * TimelineEvent represents a single event in the execution timeline, capturing both structured data and associated artifacts.
 * It is designed to be flexible and extensible, allowing for different types of events and artifacts to be added as needed.
 */
export interface TimelineEventBase {
    id: string; // Unique UUID for this event
    type: TimelineEventType;
    timestamp: number; // Unix timestamp
    artifacts: TimelineArtifacts;
    /**
     * Optional, inert execution metadata
     * NEVER used automatically
     * Only for human debugging or manual inspection
     */
    metadata?: {
        provider?: string;
        model?: string;
        requestId?: string;
        responseTimeMs?: number;
        tokensUsed?: number;
        status?: string;
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
    action: "attachArtifacts" | "providerFallback" | "streamChunk" | "debug" | "internal";

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

export interface TTSEvent extends TimelineEventBase {
    type: "tts";
}

export interface TranscriptEvent extends TimelineEventBase {
    type: "transcript";
}

export interface TranslationEvent extends TimelineEventBase {
    type: "translation";
}

export interface VideoEditEvent extends TimelineEventBase {
    type: "videoEdit";
}

export interface VideoDownloadEvent extends TimelineEventBase {
    type: "videoDownload";
}

export interface VideoGenerationEvent extends TimelineEventBase {
    type: "videoGeneration";
}

export interface VideoAnalysisEvent extends TimelineEventBase {
    type: "videoAnalysis";
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
    | TTSEvent
    | TranscriptEvent
    | TranslationEvent
    | VideoEditEvent
    | VideoDownloadEvent
    | VideoGenerationEvent
    | VideoAnalysisEvent
    | FileEvent
    | TranscriptEvent
    | TranslationEvent;
