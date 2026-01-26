import { TimelineEvent } from "#root/index.js";

/**
 * JSON-serializable snapshot of a timeline for persistence or transfer.
 */
export interface TimelineSnapshot {
    events: TimelineEvent[];
    metadata?: {
        sessionName?: string; // Optional logical grouping
        createdAt?: number; // Unix timestamp
        [key: string]: unknown;
    };
}
