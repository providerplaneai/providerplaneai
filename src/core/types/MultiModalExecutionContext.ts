/**
 * @module core/types/MultiModalExecutionContext.ts
 * @description Core shared type definitions used by runtime, providers, and workflows.
 */
import {
    TimelineEvent,
    UserMessageEvent,
    AssistantMessageEvent,
    SystemEvent,
    TimelineArtifacts,
    NormalizedChatMessage,
    NormalizedImage,
    NormalizedImageAnalysis,
    NormalizedVideoAnalysis,
    NormalizedModeration,
    NormalizedEmbedding,
    NormalizedAudio,
    NormalizedVideo,
    NormalizedFile,
    NormalizedMask,
    ImageGenerationEvent,
    ImageEditEvent,
    NormalizedUserInput,
    AIResponse,
    sanitizeTimelineArtifacts
} from "#root/index.js";

/**
 * Execution context for multi-turn, multimodal AI sessions.
 * Maintains a unified timeline with all modalities.
 *
 * Design invariants:
 * - Owns the canonical timeline
 * - Stores ONLY final AIResponse-derived artifacts
 * - Streaming chunks are ephemeral
 * - No provider logic, no retries, no orchestration
 */
/**
 * @public
 * @description Implementation class for MultiModalExecutionContext.
 */
export class MultiModalExecutionContext {
    /**
     * Unified timeline for all events
     */
    protected timeline: TimelineEvent[] = [];
    /**
     * Whether binary-heavy artifact fields are stripped when storing timeline events.
     */
    private stripBinaryPayloadsInTimeline = false;

    /**
     * Enables or disables timeline artifact payload sanitization.
     */
    setStripBinaryPayloadsInTimeline(enabled: boolean): void {
        this.stripBinaryPayloadsInTimeline = enabled;
    }

    /**
     * Begin a new logical turn with a canonical user input.
     * Input can be a chat message, image request, or any other request type.
     *
     * @param input - The user input for this turn
     */
    beginTurn(input: NormalizedUserInput): void {
        const event: UserMessageEvent = {
            id: crypto.randomUUID(),
            type: "userMessage",
            timestamp: Date.now(),
            message: input,
            artifacts: this.createEmptyArtifacts()
        };

        this.timeline.push(event);
    }

    /**
     * Apply final assistant output
     * Chat is the only modality that produces a canonical "assistantMessage".
     */
    applyAssistantMessage(message: NormalizedChatMessage): void {
        const event: AssistantMessageEvent = {
            id: crypto.randomUUID(),
            type: "assistantMessage",
            timestamp: Date.now(),
            message,
            artifacts: { ...this.createEmptyArtifacts(), chat: [message] }
        };
        this.timeline.push(event);
    }
    /**
     * Attach multimodal artifacts without producing a chat message
     */
    attachArtifacts(artifacts?: Partial<TimelineArtifacts>): void {
        const event: SystemEvent = {
            id: crypto.randomUUID(),
            type: "systemEvent",
            timestamp: Date.now(),
            action: "attachArtifacts",
            artifacts: this.mergeArtifacts(this.createEmptyArtifacts(), artifacts)
        };

        this.timeline.push(event);
    }

    /**
     * Attach multimodal artifacts with metadata sourced from an internal AIResponse.
     * Intended for internal orchestration use only.
     */
    attachArtifactsFromResponse<T>(response: AIResponse<T>, artifacts?: Partial<TimelineArtifacts>): void {
        const baseWithResponseArtifacts = this.mergeArtifacts(this.createEmptyArtifacts(), response.multimodalArtifacts);

        const event: SystemEvent = {
            id: crypto.randomUUID(),
            type: "systemEvent",
            timestamp: Date.now(),
            action: "attachArtifacts",
            artifacts: this.mergeArtifacts(baseWithResponseArtifacts, artifacts),
            metadata: response.metadata
        };

        this.timeline.push(event);
    }

    /**
     * Streaming helper.
     * Chunks are forwarded but NOT persisted as AIResponses.
     */
    yieldArtifacts(artifacts?: Partial<TimelineArtifacts>): void {
        if (!artifacts) {
            return;
        }

        const event: SystemEvent = {
            id: crypto.randomUUID(),
            type: "systemEvent",
            timestamp: Date.now(),
            action: "streamChunk",
            artifacts: this.mergeArtifacts(this.createEmptyArtifacts(), artifacts)
        };

        this.timeline.push(event);
    }
    /**
     * Reset the entire session
     */
    reset(): void {
        this.timeline = [];
    }
    /**
     * Read-only view of timeline
     */
    getTimeline(): readonly TimelineEvent[] {
        return this.timeline;
    }
    /**
     * Merge two TimelineArtifacts objects safely
     */
    private mergeArtifacts(base: TimelineArtifacts, addition?: Partial<TimelineArtifacts>): TimelineArtifacts {
        addition = addition ?? {};
        if (this.stripBinaryPayloadsInTimeline) {
            addition = sanitizeTimelineArtifacts(addition) ?? {};
        }

        const safeArray = <T>(v?: T[]): T[] => (Array.isArray(v) ? v : []);

        return {
            chat: [...safeArray(base.chat), ...safeArray(addition.chat)],
            images: [...safeArray(base.images), ...safeArray(addition.images)],
            masks: [...safeArray(base.masks), ...safeArray(addition.masks)],
            videoAnalysis: [...safeArray(base.videoAnalysis), ...safeArray(addition.videoAnalysis)],
            imageAnalysis: [...safeArray(base.imageAnalysis), ...safeArray(addition.imageAnalysis)],
            transcript: [...safeArray(base.transcript), ...safeArray(addition.transcript)],
            translation: [...safeArray(base.translation), ...safeArray(addition.translation)],
            embeddings: [...safeArray(base.embeddings), ...safeArray(addition.embeddings)],
            moderation: [...safeArray(base.moderation), ...safeArray(addition.moderation)],
            tts: [...safeArray(base.tts), ...safeArray(addition.tts)],
            video: [...safeArray(base.video), ...safeArray(addition.video)],
            files: [...safeArray(base.files), ...safeArray(addition.files)],
            custom: [...safeArray(base.custom), ...safeArray(addition.custom)]
        };
    }
    /**
     * Create an empty TimelineArtifacts object
     */
    private createEmptyArtifacts(): TimelineArtifacts {
        return {
            chat: [],
            images: [],
            masks: [],
            imageAnalysis: [],
            videoAnalysis: [],
            transcript: [],
            translation: [],
            embeddings: [],
            moderation: [],
            tts: [],
            video: [],
            files: [],
            custom: []
        };
    }
    /**
     * Generic helper to find the latest artifact type in the timeline
     */
    private findLatest<T>(predicate: (e: TimelineEvent) => T | undefined): T | undefined {
        // Reverse scan keeps reads O(n) without storing per-modality indexes and
        // always returns the most recent event payload for that modality.
        for (let i = this.timeline.length - 1; i >= 0; i--) {
            const result = predicate(this.timeline[i]);
            if (result !== undefined) {
                return result;
            }
        }
        return undefined;
    }

    getLatestChat(): NormalizedChatMessage[] {
        // "Latest" is event-local, not cumulative over all prior turns.
        return this.findLatest((e) => e.artifacts.chat) ?? [];
    }

    getLatestImages(): NormalizedImage[] {
        return this.findLatest((e) => e.artifacts.images) ?? [];
    }

    getLatestMasks(): NormalizedMask[] {
        return this.findLatest((e) => e.artifacts.masks) ?? [];
    }

    getLatestImageAnalysis(): NormalizedImageAnalysis[] {
        return this.findLatest((e) => e.artifacts.imageAnalysis) ?? [];
    }

    getLatestVideoAnalysis(): NormalizedVideoAnalysis[] {
        return this.findLatest((e) => e.artifacts.videoAnalysis) ?? [];
    }

    getLatestEmbeddings(): NormalizedEmbedding[] {
        return this.findLatest((e) => e.artifacts.embeddings) ?? [];
    }

    getLatestModeration(): NormalizedModeration[] {
        return this.findLatest((e) => e.artifacts.moderation) ?? [];
    }

    getLatestTTS(): NormalizedAudio[] {
        return this.findLatest((e) => e.artifacts.tts) ?? [];
    }

    getLatestTranscript(): NormalizedChatMessage[] {
        return this.findLatest((e) => e.artifacts.transcript) ?? [];
    }

    getLatestTranslation(): NormalizedChatMessage[] {
        return this.findLatest((e) => e.artifacts.translation) ?? [];
    }

    getLatestVideo(): NormalizedVideo[] {
        return this.findLatest((e) => e.artifacts.video) ?? [];
    }

    getLatestFile(): NormalizedFile[] {
        return this.findLatest((e) => e.artifacts.files) ?? [];
    }
    /**
     * Helper to get latest ImageGenerationEvent specifically
     */
    getLatestImageGeneration(): ImageGenerationEvent | undefined {
        return this.findLatest((e): ImageGenerationEvent | undefined =>
            e.type === "imageGeneration" ? (e as ImageGenerationEvent) : undefined
        );
    }
    /**
     * Helper to get latest ImageEditEvent specifically
     */
    getLatestImageEdit(): ImageEditEvent | undefined {
        return this.findLatest((e): ImageEditEvent | undefined => (e.type === "imageEdit" ? (e as ImageEditEvent) : undefined));
    }
}
