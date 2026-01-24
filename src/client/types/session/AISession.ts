import { MultiModalExecutionContext, SessionEvent, SessionSnapshot } from "#root/index.js";

/**
 * Represents a single AI session, tracking all events and multimodal context.
 *
 * Responsibilities:
 * - Stable session identity
 * - Flat event timeline (telemetry, chunks, artifacts, etc.)
 * - Owns the global MultiModalExecutionContext
 */
export class AISession {
    readonly id: string;

    /** Timeline of events (requests, responses, chunks, artifacts, etc.) */
    private events: SessionEvent[] = [];

    /** Global execution context holding all turns and multimodal state */
    private readonly context: MultiModalExecutionContext;

    constructor(id?: string, context?: MultiModalExecutionContext) {
        this.id = id ?? crypto.randomUUID();
        this.context = context ?? new MultiModalExecutionContext();
    }

    /** Access the global multimodal execution context */
    getContext(): MultiModalExecutionContext {
        return this.context;
    }

    /** Add a new typed event to the session timeline */
    addEvent<TPayload>(event: SessionEvent<TPayload>) {
        this.events.push(event);
    }

    /** Retrieve a read-only copy of all events */
    getEvents(): readonly SessionEvent<unknown>[] {
        return [...this.events];
    }

    /** Clear all events (does not affect execution context) */
    resetEvents(): void {
        this.events = [];
    }

    /**
     * Serialize only what AISession owns directly.
     * The context is serialized separately by SessionSerializer.
     */
    serializeBase(): Pick<SessionSnapshot, "id" | "events"> {
        return {
            id: this.id,
            events: [...this.events]
        };
    }

    /**
     * Restore an AISession from the base portion of a snapshot.
     * The MultiModalExecutionContext is restored separately.
     */
    static fromBaseSnapshot(base: Pick<SessionSnapshot, "id" | "events">, context?: MultiModalExecutionContext): AISession {
        const session = new AISession(base.id, context);

        if (base.events) {
            for (const e of base.events) {
                session.addEvent(e);
            }
        }

        return session;
    }
}
