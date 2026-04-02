/**
 * @module core/types/timeline/TimelineEvents.ts
 * @description Timeline event contracts used by the multimodal execution context.
 */
import { NormalizedChatMessage, NormalizedUserInput, TimelineArtifacts } from "#root/index.js";

/**
 * @public
 * All valid timeline event type identifiers.
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
 * @public
 * Base contract for all timeline events.
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
 * @public
 * User-message event recorded at the start of a turn.
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
 * @public
 * Assistant-message event recorded for canonical chat output.
 */
export interface AssistantMessageEvent extends TimelineEventBase {
    type: "assistantMessage";
    /**
     * Canonical assistant reply for this turn
     */
    message: NormalizedChatMessage;
}

/**
 * @public
 * Internal system event used for artifacts, stream chunks, and diagnostics.
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
 * @public
 * Artifact-only embedding event.
 */
export interface EmbeddingEvent extends TimelineEventBase {
    type: "embedding";
}

/**
 * @public
 * Artifact-only image-generation event.
 */
export interface ImageGenerationEvent extends TimelineEventBase {
    type: "imageGeneration";
}

/**
 * @public
 * Artifact-only image-edit event.
 */
export interface ImageEditEvent extends TimelineEventBase {
    type: "imageEdit";
}

/**
 * @public
 * Artifact-only image-analysis event.
 */
export interface ImageAnalysisEvent extends TimelineEventBase {
    type: "imageAnalysis";
}

/**
 * @public
 * Artifact-only moderation event.
 */
export interface ModerationEvent extends TimelineEventBase {
    type: "moderation";
}

/**
 * @public
 * Artifact-only text-to-speech event.
 */
export interface TTSEvent extends TimelineEventBase {
    type: "tts";
}

/**
 * @public
 * Artifact-only transcript event.
 */
export interface TranscriptEvent extends TimelineEventBase {
    type: "transcript";
}

/**
 * @public
 * Artifact-only translation event.
 */
export interface TranslationEvent extends TimelineEventBase {
    type: "translation";
}

/**
 * @public
 * Artifact-only video-edit event.
 */
export interface VideoEditEvent extends TimelineEventBase {
    type: "videoEdit";
}

/**
 * @public
 * Artifact-only video-download event.
 */
export interface VideoDownloadEvent extends TimelineEventBase {
    type: "videoDownload";
}

/**
 * @public
 * Artifact-only video-generation event.
 */
export interface VideoGenerationEvent extends TimelineEventBase {
    type: "videoGeneration";
}

/**
 * @public
 * Artifact-only video-analysis event.
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
