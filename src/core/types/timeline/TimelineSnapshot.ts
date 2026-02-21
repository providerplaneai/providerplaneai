import { TimelineEvent } from "#root/index.js";

/**
 * JSON-serializable snapshot of a timeline for persistence, resuming, or transfer.
 * Fully compatible with GenericJob multi-chunk execution.
 */
export interface TimelineSnapshot {
    /** All events in chronological order */
    events: TimelineEvent[];

    /** Optional session-level metadata */
    metadata?: {
        sessionName?: string; // Logical grouping
        createdAt?: number; // Unix timestamp (ms)
        [key: string]: unknown;
    };
}
