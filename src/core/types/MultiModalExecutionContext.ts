/**
 * @module core/types/MultiModalExecutionContext.ts
 * @description Timeline-backed execution context for multi-turn, multimodal workflows.
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
    NormalizedOCRDocument,
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
 * Timeline-backed execution context for multi-turn multimodal sessions.
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
     *
     * @param {boolean} enabled - Whether binary-heavy artifact fields should be stripped before storage.
     */
    setStripBinaryPayloadsInTimeline(enabled: boolean): void {
        this.stripBinaryPayloadsInTimeline = enabled;
    }

    /**
     * Begin a new logical turn with a canonical user input.
     * Input can be a chat message, image request, or any other request type.
     *
     * @param {NormalizedUserInput} input - The canonical user input for this turn.
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
     * Applies a final assistant chat message to the timeline.
     *
     * @param {NormalizedChatMessage} message - Final assistant message to append.
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
     * Attaches multimodal artifacts without producing a chat message.
     *
     * @param {Partial<TimelineArtifacts> | undefined} artifacts - Artifacts to append to the timeline.
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
     * Attaches multimodal artifacts with metadata sourced from an internal AI response.
     * Intended for internal orchestration use only.
     *
     * @template T - Response output type.
     * @param {AIResponse<T>} response - Source response whose artifacts and metadata should be attached.
     * @param {Partial<TimelineArtifacts> | undefined} artifacts - Additional artifacts to merge on top of the response artifacts.
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
     * Records streamed artifacts without materializing them as full AI responses.
     *
     * @param {Partial<TimelineArtifacts> | undefined} artifacts - Streamed artifacts to append or coalesce.
     */
    yieldArtifacts(artifacts?: Partial<TimelineArtifacts>): void {
        if (!artifacts) {
            return;
        }

        const mergedArtifacts = this.mergeArtifacts(this.createEmptyArtifacts(), artifacts);
        if (this.isArtifactsEmpty(mergedArtifacts)) {
            return;
        }

        const lastEvent = this.timeline[this.timeline.length - 1];
        if (lastEvent?.type === "systemEvent" && lastEvent.action === "streamChunk") {
            // Coalesce consecutive stream chunks to avoid timeline growth under token streaming.
            lastEvent.artifacts = this.mergeArtifacts(lastEvent.artifacts, mergedArtifacts);
            lastEvent.timestamp = Date.now();
            return;
        }

        const event: SystemEvent = {
            id: crypto.randomUUID(),
            type: "systemEvent",
            timestamp: Date.now(),
            action: "streamChunk",
            artifacts: mergedArtifacts
        };

        this.timeline.push(event);
    }
    /**
     * Resets the entire session timeline.
     */
    reset(): void {
        this.timeline = [];
    }
    /**
     * Returns a read-only view of the current timeline.
     *
     * @returns {readonly TimelineEvent[]} Timeline events in chronological order.
     */
    getTimeline(): readonly TimelineEvent[] {
        return this.timeline;
    }
    /**
     * Merges two `TimelineArtifacts` objects safely.
     *
     * @param {TimelineArtifacts} base - Existing artifact set.
     * @param {Partial<TimelineArtifacts> | undefined} addition - Additional artifacts to merge.
     * @returns {TimelineArtifacts} Merged artifact set.
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
            ocr: [...safeArray(base.ocr), ...safeArray(addition.ocr)],
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
     * Creates an empty `TimelineArtifacts` object.
     *
     * @returns {TimelineArtifacts} Empty artifact container.
     */
    private createEmptyArtifacts(): TimelineArtifacts {
        return {
            chat: [],
            images: [],
            masks: [],
            imageAnalysis: [],
            ocr: [],
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
     * Returns `true` when all artifact arrays are empty.
     *
     * @param {TimelineArtifacts} artifacts - Artifact set to inspect.
     * @returns {boolean} `true` when all artifact arrays are empty.
     */
    private isArtifactsEmpty(artifacts: TimelineArtifacts): boolean {
        const sizeOf = (value: unknown): number => (Array.isArray(value) ? value.length : 0);
        return (
            sizeOf(artifacts.chat) === 0 &&
            sizeOf(artifacts.images) === 0 &&
            sizeOf(artifacts.masks) === 0 &&
            sizeOf(artifacts.imageAnalysis) === 0 &&
            sizeOf(artifacts.ocr) === 0 &&
            sizeOf(artifacts.videoAnalysis) === 0 &&
            sizeOf(artifacts.transcript) === 0 &&
            sizeOf(artifacts.translation) === 0 &&
            sizeOf(artifacts.embeddings) === 0 &&
            sizeOf(artifacts.moderation) === 0 &&
            sizeOf(artifacts.tts) === 0 &&
            sizeOf(artifacts.video) === 0 &&
            sizeOf(artifacts.files) === 0 &&
            sizeOf(artifacts.custom) === 0
        );
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

    getLatestOCR(): NormalizedOCRDocument[] {
        return this.findLatest((e) => e.artifacts.ocr) ?? [];
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
