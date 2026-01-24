import { CapabilityKeyType } from "#root/index.js";

export type SessionEventType = "request" | "response" | "chunk" | "summary" | "tool";

/**
 * Represents a single event in a session timeline (request, response, chunk, etc.).
 *
 * - `id`: Unique event ID.
 * - `timestamp`: Event creation time (ms since epoch).
 * - `eventType`: Type of event (request, response, chunk, etc.).
 * - `capability`: Capability key or logical name (e.g., "chat").
 * - `payload`: Event payload (type varies by event).
 */
export interface SessionEvent<TPayload = unknown> {
    /** Unique session ID */
    id: string;
    /** Timestamp of snapshot creation */
    timestamp: number;

    /** "request" | "response" | "chunk" | etc */
    eventType: SessionEventType;

    /** Capability key or logical name: "chat", etc */
    capability: CapabilityKeyType;

    payload: TPayload;
}
