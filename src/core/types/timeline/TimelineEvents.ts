/**
 * @module core/types/timeline/TimelineEvents.ts
 * @description Core shared type definitions used by runtime, providers, and workflows.
 */
import { NormalizedChatMessage, NormalizedUserInput, TimelineArtifacts } from "#root/index.js";

/**
 * All valid timeline event types
 */
/**
 * @public
 * @description Alias type for TimelineEventType.
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
/**
 * @public
 * @description Data contract for TimelineEventBase.
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
/**
 * @public
 * @description Data contract for UserMessageEvent.
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
/**
 * @public
 * @description Data contract for AssistantMessageEvent.
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
/**
 * @public
 * @description Data contract for SystemEvent.
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
/**
 * @public
 * @description Data contract for EmbeddingEvent.
 */
export interface EmbeddingEvent extends TimelineEventBase {
    type: "embedding";
}

/**
 * @public
 * @description Data contract for ImageGenerationEvent.
 */
export interface ImageGenerationEvent extends TimelineEventBase {
    type: "imageGeneration";
}

/**
 * @public
 * @description Data contract for ImageEditEvent.
 */
export interface ImageEditEvent extends TimelineEventBase {
    type: "imageEdit";
}

/**
 * @public
 * @description Data contract for ImageAnalysisEvent.
 */
export interface ImageAnalysisEvent extends TimelineEventBase {
    type: "imageAnalysis";
}

/**
 * @public
 * @description Data contract for ModerationEvent.
 */
export interface ModerationEvent extends TimelineEventBase {
    type: "moderation";
}

/**
 * @public
 * @description Data contract for TTSEvent.
 */
export interface TTSEvent extends TimelineEventBase {
    type: "tts";
}

/**
 * @public
 * @description Data contract for TranscriptEvent.
 */
export interface TranscriptEvent extends TimelineEventBase {
    type: "transcript";
}

/**
 * @public
 * @description Data contract for TranslationEvent.
 */
export interface TranslationEvent extends TimelineEventBase {
    type: "translation";
}

/**
 * @public
 * @description Data contract for VideoEditEvent.
 */
export interface VideoEditEvent extends TimelineEventBase {
    type: "videoEdit";
}

/**
 * @public
 * @description Data contract for VideoDownloadEvent.
 */
export interface VideoDownloadEvent extends TimelineEventBase {
    type: "videoDownload";
}

/**
 * @public
 * @description Data contract for VideoGenerationEvent.
 */
export interface VideoGenerationEvent extends TimelineEventBase {
    type: "videoGeneration";
}

/**
 * @public
 * @description Data contract for VideoAnalysisEvent.
 */
export interface VideoAnalysisEvent extends TimelineEventBase {
    type: "videoAnalysis";
}

/**
 * @public
 * @description Data contract for FileEvent.
 */
export interface FileEvent extends TimelineEventBase {
    type: "file";
}

/**
 * Union type for all timeline events
 */
/**
 * @public
 * @description Alias type for TimelineEvent.
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
