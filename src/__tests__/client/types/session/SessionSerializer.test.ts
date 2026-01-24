import { describe, it, expect } from 'vitest';
import { SessionSerializer } from '#root/client/types/session/SessionSerializer.js';
import { AISession } from '#root/client/types/session/AISession.js';
import { MultiModalExecutionContext, SessionEvent, SessionSnapshot } from '#root/index.js';

describe('SessionSerializer', () => {
    it('serializes a session with context and events', () => {
        const session = new AISession('sid');
        const ctx = session.getContext();
        ctx.chatMessages.push({ role: 'user', content: [{ type: 'text', text: 'hi' }] });
        ctx.images.push({ id: 'img1', url: 'x', mimeType: 'image/png', raw: {} });
        ctx.masks.push({ id: 'mask1', url: 'y', mimeType: 'image/png', raw: {} });
        ctx.artifacts.foo = 'bar';
        session.addEvent({
            id: 'sid',
            timestamp: 1,
            eventType: 'request',
            capability: 'chat',
            payload: { test: true }
        });
        const snap = SessionSerializer.serialize(session);
        expect(snap.id).toBe('sid');
        expect((snap.events ?? []).length).toBe(1);
        expect(snap.context.chatMessages.length).toBe(1);
        expect(snap.context.images.length).toBe(1);
        expect(snap.context.masks.length).toBe(1);
        expect(snap.context.artifacts.foo).toBe('bar');
    });

    it('deserializes a snapshot with events and context', () => {
        const snapshot: SessionSnapshot = {
            id: 'sid',
            events: [{
                id: 'sid',
                timestamp: 2,
                eventType: 'response',
                capability: 'chat',
                payload: { ok: true }
            }],
            context: {
                history: [],
                chatMessages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
                images: [{ id: 'img2', url: 'z', mimeType: 'image/png', raw: {} }],
                masks: [{ id: 'mask2', url: 'w', mimeType: 'image/png', raw: {} }],
                artifacts: { bar: 'baz' }
            }
        };
        const { session, context } = SessionSerializer.deserialize(snapshot);
        expect(session.id).toBe('sid');
        expect(session.getEvents().length).toBe(1);
        expect(context.chatMessages.length).toBe(1);
        expect(context.images.length).toBe(1);
        expect(context.masks.length).toBe(1);
        expect(context.artifacts.bar).toBe('baz');
    });

    it('deserializes with empty events', () => {
        const snapshot: SessionSnapshot = {
            id: 'sid',
            context: {
                history: [],
                chatMessages: [],
                images: [],
                masks: [],
                artifacts: {}
            }
        };
        const { session, context } = SessionSerializer.deserialize(snapshot);
        expect(session.id).toBe('sid');
        expect(session.getEvents().length).toBe(0);
        expect(context.chatMessages.length).toBe(0);
    });

    it('deserializes and restores history with providerOutput and multimodalArtifacts', () => {
        const snapshot: SessionSnapshot = {
            id: 'sid',
            context: {
                history: [{
                    turn: 1,
                    input: { prompt: 'test' },
                    providerOutput: 'output',
                    multimodalArtifacts: { chat: [{ id: 'c3', role: 'user', content: [{ type: 'text', text: 'yo' }] }] }
                }],
                chatMessages: [],
                images: [],
                masks: [],
                artifacts: {}
            }
        };
        const { context } = SessionSerializer.deserialize(snapshot);
        expect(context.getHistory().length).toBe(1);
        expect(context.getHistory()[0].providerOutput).toBe('output');
        const chatArr = Array.isArray(context.getHistory()[0]?.multimodalArtifacts?.chat)
            ? (context.getHistory()[0]?.multimodalArtifacts?.chat as any[])
            : [];
        expect(chatArr[0]?.role).toBe('user');
        expect(chatArr[0]?.content[0]?.text).toBe('yo');
    });

    it('deserializes and restores history with only multimodalArtifacts', () => {
        const snapshot: SessionSnapshot = {
            id: 'sid',
            context: {
                history: [{
                    turn: 1,
                    input: { prompt: 'test' },
                    multimodalArtifacts: { images: [{ id: 'img3', sourceType: 'url', url: 'img-url' }] }
                }],
                chatMessages: [],
                images: [],
                masks: [],
                artifacts: {}
            }
        };
        const { context } = SessionSerializer.deserialize(snapshot);
        expect(context.getHistory().length).toBe(1);
        const imagesArr = Array.isArray(context.getHistory()[0]?.multimodalArtifacts?.images)
            ? (context.getHistory()[0]?.multimodalArtifacts?.images as any[])
            : [];
        expect(imagesArr[0]?.id).toBe('img3');
    });
});
