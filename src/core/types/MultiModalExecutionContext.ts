import { ClientChatMessage, NormalizedImage, SessionTurnHistoryEntry } from "#root/index.js";

/**
 * Execution context for multi-turn, multimodal AI sessions.
 *
 * Responsibilities:
 * - Maintain global turn order across all modalities
 * - Track provider input, output, and multimodal artifacts
 * - Support chat, images, audio, or other structured outputs
 */
export class MultiModalExecutionContext {
    /** Internal turn history (mutable) */
    protected history: SessionTurnHistoryEntry<any, any>[] = [];
    protected turnIndex = 0;

    /** Flattened global state for chat, images, masks */
    public chatMessages: ClientChatMessage[] = [];
    public images: NormalizedImage[] = [];
    public masks: NormalizedImage[] = [];
    public artifacts: Record<string, unknown> = {};

    /** Begin a new logical turn */
    beginTurn(input: unknown): void {
        this.turnIndex += 1;
        this.history.push({
            turn: this.turnIndex,
            providerOutput: undefined,
            multimodalArtifacts: {},
            input
        });
    }

    /** Apply a completed provider output to the current turn */
    applyOutput(output: unknown, multimodalArtifacts?: Record<string, unknown>): void {
        const currentTurn = this.history[this.history.length - 1];
        if (!currentTurn) {
            throw new Error("No active turn. Call beginTurn first.");
        }

        currentTurn.providerOutput = output;

        if (multimodalArtifacts) {
            currentTurn.multimodalArtifacts = {
                ...(currentTurn.multimodalArtifacts ?? {}),
                ...multimodalArtifacts
            };

            // Update flattened global state
            this.updateGlobalArtifacts(multimodalArtifacts);
        }
    }

    /** Attach multimodal artifacts without marking provider output */
    attachMultimodalArtifacts(artifacts: Record<string, unknown>): void {
        const currentTurn = this.history[this.history.length - 1];
        if (!currentTurn) {
            throw new Error("attachMultimodalArtifacts called before beginTurn");
        }

        currentTurn.multimodalArtifacts = {
            ...(currentTurn.multimodalArtifacts ?? {}),
            ...artifacts
        };

        this.updateGlobalArtifacts(artifacts);
    }

    /** Helper to update flattened state */
    private updateGlobalArtifacts(artifacts: Record<string, unknown>) {
        if (artifacts.chat) {
            this.chatMessages.push(...(artifacts.chat as ClientChatMessage[]));
        }
        if (artifacts.images) {
            this.images.push(...(artifacts.images as NormalizedImage[]));
        }
        if (artifacts.masks) {
            this.masks.push(...(artifacts.masks as NormalizedImage[]));
        }
        Object.assign(this.artifacts, artifacts);
    }

    /** Streaming helper: attach artifacts and optionally a partial/final output */
    yieldArtifacts(output?: unknown, artifacts?: Record<string, unknown>): void {
        if (output !== undefined) {
            this.applyOutput(output, artifacts);
        } else if (artifacts) {
            this.attachMultimodalArtifacts(artifacts);
        }
    }

    /** Build provider-facing input for the current turn */
    buildProviderInput(): any {
        const currentTurn = this.history[this.history.length - 1];
        if (!currentTurn) {
            throw new Error("No turn started");
        }
        return currentTurn.input;
    }

    /** Read-only view of the turn history */
    getHistory(): readonly SessionTurnHistoryEntry<any, any>[] {
        return this.history;
    }

    /** Reset all session state */
    reset(): void {
        this.history = [];
        this.turnIndex = 0;
        this.chatMessages = [];
        this.images = [];
        this.masks = [];
        this.artifacts = {};
    }

    /** Convenience: get the last chat message */
    getLastChatMessage(): ClientChatMessage | undefined {
        return this.chatMessages[this.chatMessages.length - 1];
    }

    /** Convenience: get the last generated image */
    getLastImage(): NormalizedImage | undefined {
        return this.images[this.images.length - 1];
    }

    /** Convenience: get the last mask */
    getLastMask(): NormalizedImage | undefined {
        return this.masks[this.masks.length - 1];
    }
}
