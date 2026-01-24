import { AISession, MultiModalExecutionContext, SessionSnapshot } from "#root/index.js";

/**
 * Utility for serializing and deserializing AISession objects and their multimodal context.
 * Enables session persistence and restoration for timeline, context, and artifacts.
 */
export class SessionSerializer {
    /**
     * Serialize an AISession and its multimodal context into a SessionSnapshot.
     * @param session The session to serialize
     * @returns SessionSnapshot containing session ID, events, and context state
     */
    static serialize(session: AISession): SessionSnapshot {
        const ctx: MultiModalExecutionContext = session.getContext();

        return {
            id: session.id,
            events: session.getEvents(),
            context: {
                history: ctx.getHistory(),
                chatMessages: [...ctx.chatMessages],
                images: [...ctx.images],
                masks: [...ctx.masks],
                artifacts: { ...ctx.artifacts }
            }
        };
    }

    /**
     * Deserialize a SessionSnapshot into a new AISession and multimodal context.
     * Restores timeline, context history, and artifacts.
     * @param snapshot The snapshot to restore from
     * @returns Object containing the restored session and context
     */
    static deserialize(snapshot: SessionSnapshot): { session: AISession; context: MultiModalExecutionContext } {
        const session = new AISession(snapshot.id);

        if (snapshot.events) {
            for (const e of snapshot.events) {
                session.addEvent(e);
            }
        }

        const ctx = new MultiModalExecutionContext();
        // Restore turn history in order
        for (const entry of snapshot.context.history) {
            ctx.beginTurn(entry.input);

            if (entry.providerOutput !== undefined) {
                ctx.applyOutput(entry.providerOutput, entry.multimodalArtifacts);
            } else if (entry.multimodalArtifacts) {
                ctx.attachMultimodalArtifacts(entry.multimodalArtifacts);
            }
        }
        // Restore global state
        ctx.chatMessages = [...snapshot.context.chatMessages];
        ctx.images = [...snapshot.context.images];
        ctx.masks = [...snapshot.context.masks];
        ctx.artifacts = { ...snapshot.context.artifacts };
        return { session, context: ctx };
    }
}
