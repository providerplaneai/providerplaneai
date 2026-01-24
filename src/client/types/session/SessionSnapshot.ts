import { ClientChatMessage, NormalizedImage, SessionEvent, SessionTurnHistoryEntry } from "#root/index.js";

/**
 * JSON-serializable snapshot of a session for persistence or transfer.
 *
 * Includes session ID, event timeline, and authoritative multimodal state.
 */
export interface SessionSnapshot {
    /** Session identifier */
    id: string;

    /**
     * Optional flat event timeline (telemetry, debugging, replay, etc.)
     * Not required to reconstruct session state.
     */
    events?: readonly SessionEvent<unknown>[];

    /**
     * Authoritative multimodal session state.
     * This is a direct snapshot of MultiModalExecutionContext.
     */
    context: {
        history: readonly SessionTurnHistoryEntry<any, any>[];

        chatMessages: readonly ClientChatMessage[];
        images: readonly NormalizedImage[];
        masks: readonly NormalizedImage[];
        artifacts: Readonly<Record<string, unknown>>;
    };
}
