import { TimelineEvent, TimelineSnapshot } from "#root/index.js";

export class TimelineSerializer {
    static serialize(timeline: TimelineEvent[], metadata?: Record<string, unknown>): TimelineSnapshot {
        return { events: [...timeline], metadata: { ...metadata, createdAt: Date.now() } };
    }

    static deserialize(snapshot: TimelineSnapshot): TimelineEvent[] {
        return [...snapshot.events];
    }
}
