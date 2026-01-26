import { AssistantMessageEvent, SystemEvent, TimelineArtifacts, TimelineEvent, UserMessageEvent } from "#root/index.js";

/**
 * Execution context for multi-turn, multimodal AI sessions.
 *
 * Responsibilities:
 * - Maintain global turn order across all modalities
 * - Track provider input, output, and multimodal artifacts
 * - Support chat, images, audio, or other structured outputs
 * - Compatible with streaming updates and per-turn aggregation
 */
export class MultiModalExecutionContext {
    /** Unified global timeline for all modalities */
    protected timeline: TimelineEvent[] = [];
    protected turnIndex = 0;

    /** Begin a new logical turn */
    beginTurn<TInputType = unknown>(input: TInputType): void {
        this.turnIndex++;

        let event: TimelineEvent;

        if (typeof input === "string" || Array.isArray(input)) {
            event = {
                id: crypto.randomUUID(),
                type: "userMessage",
                timestamp: Date.now(),
                content: input,
                artifacts: this.createEmptyArtifacts()
            } as UserMessageEvent;
        } else {
            // Fallback to system event for arbitrary unknown inputs
            event = {
                id: crypto.randomUUID(),
                type: "systemEvent",
                timestamp: Date.now(),
                message: JSON.stringify(input),
                artifacts: this.createEmptyArtifacts()
            } as SystemEvent;
        }

        this.timeline.push(event);
    }

    /** Apply a completed provider output to the current turn */
    applyOutput<TOutputType = unknown>(output: TOutputType, multimodalArtifacts?: Partial<TimelineArtifacts>): void {
        const currentTurn = this.getCurrentTurn();
        const mergedArtifacts = this.mergeArtifacts(currentTurn.artifacts, multimodalArtifacts);

        let event: TimelineEvent;
        const id = crypto.randomUUID();
        const timestamp = Date.now();

        switch (currentTurn.type) {
            case "userMessage":
            case "assistantMessage":
                event = {
                    id,
                    type: "assistantMessage",
                    timestamp,
                    content: output as any, // TS can't fully enforce; generic ensures flexibility
                    artifacts: mergedArtifacts
                } as AssistantMessageEvent;
                break;
            default:
                event = {
                    id,
                    type: "systemEvent",
                    timestamp,
                    message: JSON.stringify(output),
                    artifacts: mergedArtifacts
                } as SystemEvent;
        }

        this.timeline.push(event);
    }

    /** Attach multimodal artifacts without marking provider output */
    attachMultimodalArtifacts(multimodalArtifacts: Partial<TimelineArtifacts>): void {
        const currentTurn = this.getCurrentTurn();
        const mergedArtifacts = this.mergeArtifacts(currentTurn.artifacts, multimodalArtifacts);

        this.timeline.push({
            id: crypto.randomUUID(),
            timestamp: Date.now(),
            type: "systemEvent",
            message: "Attached artifacts",
            artifacts: mergedArtifacts
        } as SystemEvent);
    }

    /** Streaming helper: attach artifacts and optionally a partial/final output */
    yieldArtifacts<TOutputType = unknown>(output?: TOutputType, artifacts?: Partial<TimelineArtifacts>): void {
        if (output !== undefined) {
            this.applyOutput(output, artifacts);
        } else if (artifacts) {
            this.attachMultimodalArtifacts(artifacts);
        }
    }

    /** Build provider-facing input for the current turn */
    buildProviderInput(): unknown {
        const currentTurn = this.getCurrentTurn();

        if (currentTurn.type === "userMessage" || currentTurn.type === "assistantMessage") {
            return currentTurn.content;
        } else if (currentTurn.type === "systemEvent") {
            return currentTurn.message;
        } else {
            return null;
        }
    }

    private getCurrentTurn(): TimelineEvent {
        const currentTurn = this.timeline[this.timeline.length - 1];
        if (!currentTurn) {
            throw new Error("No active turn. Call beginTurn first.");
        }
        return currentTurn;
    }

    /** Read-only view of the turn history */
    getTimeline(): readonly TimelineEvent[] {
        return this.timeline;
    }

    /** Reset all session state */
    reset(): void {
        this.timeline = [];
        this.turnIndex = 0;
    }

    private createEmptyArtifacts(): TimelineArtifacts {
        return {
            images: [],
            masks: [],
            chat: [],
            audioArtifacts: [],
            videoArtifacts: [],
            files: []
        };
    }

    /**
     * Merge two TimelineArtifacts objects
     * Preserves existing data and appends new items
     */
    private mergeArtifacts(base: TimelineArtifacts | undefined, addition?: Partial<TimelineArtifacts>): TimelineArtifacts {
        if (!base) {
            base = this.createEmptyArtifacts();
        }
        if (!addition) {
            return base;
        }

        return {
            images: [...(base.images ?? []), ...(addition.images ?? [])],
            masks: [...(base.masks ?? []), ...(addition.masks ?? [])],
            chat: [...(base.chat ?? []), ...(addition.chat ?? [])],
            audioArtifacts: [...(base.audioArtifacts ?? []), ...(addition.audioArtifacts ?? [])],
            videoArtifacts: [...(base.videoArtifacts ?? []), ...(addition.videoArtifacts ?? [])],
            files: [...(base.files ?? []), ...(addition.files ?? [])],
            ...Object.keys(addition)
                .filter((k) => !["images", "masks", "chat", "audioArtifacts", "videoArtifacts", "files"].includes(k))
                .reduce(
                    (acc, k) => {
                        acc[k] = addition[k];
                        return acc;
                    },
                    {} as Record<string, unknown>
                )
        };
    }
}
