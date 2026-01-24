    it('fromBaseSnapshot handles missing events', () => {
        const ctx = new MultiModalExecutionContext();
        const base: Pick<SessionSnapshot, 'id' | 'events'> = {
            id: 'no-events'
            // events is undefined
        };
        const restored = AISession.fromBaseSnapshot(base, ctx);
        expect(restored.id).toBe('no-events');
        expect(restored.getContext()).toBe(ctx);
        expect(restored.getEvents().length).toBe(0);
    });
import { describe, it, expect, beforeEach } from 'vitest';
import { AISession } from '#root/client/types/session/AISession.js';
import { MultiModalExecutionContext, SessionEvent, SessionSnapshot } from '#root/index.js';

describe('AISession', () => {
    let session: AISession;
    beforeEach(() => {
        session = new AISession();
    });

    it('constructs with default id and context', () => {
        expect(session.id).toBeDefined();
        expect(session.getContext()).toBeInstanceOf(MultiModalExecutionContext);
    });

    it('constructs with custom id and context', () => {
        const ctx = new MultiModalExecutionContext();
        const customId = 'custom-id';
        const s = new AISession(customId, ctx);
        expect(s.id).toBe(customId);
        expect(s.getContext()).toBe(ctx);
    });

    it('addEvent and getEvents work', () => {
        const event: SessionEvent = {
            id: session.id,
            timestamp: Date.now(),
            eventType: 'request',
            capability: 'chat',
            payload: { foo: 'bar' }
        };
        session.addEvent(event);
        const events = session.getEvents();
        expect(events.length).toBe(1);
        expect(events[0]).toEqual(event);
    });

    it('resetEvents clears events', () => {
        const event: SessionEvent = {
            id: session.id,
            timestamp: Date.now(),
            eventType: 'response',
            capability: 'chat',
            payload: { baz: 'qux' }
        };
        session.addEvent(event);
        expect(session.getEvents().length).toBe(1);
        session.resetEvents();
        expect(session.getEvents().length).toBe(0);
    });

    it('serializeBase returns correct snapshot', () => {
        const event: SessionEvent = {
            id: session.id,
            timestamp: Date.now(),
            eventType: 'chunk',
            capability: 'chat',
            payload: { chunk: 1 }
        };
        session.addEvent(event);
        const base = session.serializeBase();
        expect(base.id).toBe(session.id);
        expect(base?.events?.length).toBe(1);
        expect(base?.events?.[0]).toEqual(event);
    });

    it('fromBaseSnapshot restores session and events', () => {
        const ctx = new MultiModalExecutionContext();
        const base: Pick<SessionSnapshot, 'id' | 'events'> = {
            id: 'restore-id',
            events: [{
                id: 'restore-id',
                timestamp: 123,
                eventType: 'request',
                capability: 'chat',
                payload: { test: true }
            }]
        };
        const restored = AISession.fromBaseSnapshot(base, ctx);
        expect(restored.id).toBe('restore-id');
        expect(restored.getContext()).toBe(ctx);
        expect(restored.getEvents().length).toBe(1);
        expect(restored.getEvents()[0].payload).toEqual({ test: true });
    });
});
