import { MultiModalExecutionContext } from '#root/core/types/MultiModalExecutionContext.js';
import { describe, it, expect, beforeEach } from 'vitest';

import type { ClientChatMessage } from '#root/client/types/chat/ClientChatMessage.js';
import type { ClientMessagePart } from '#root/client/types/chat/ClientMessageParts.js';


// Mocks for types used in context
const mockChatMsg: ClientChatMessage = { role: 'user', content: [{ type: 'text', text: 'hi' } as ClientMessagePart] };
const mockImage = { url: 'img.png', mimeType: 'image/png', raw: {}, id: 'img1' };
const mockMask = { url: 'mask.png', mimeType: 'image/png', raw: {}, id: 'mask1' };


describe('MultiModalExecutionContext', () => {
    let ctx: MultiModalExecutionContext;

    beforeEach(() => {
        ctx = new MultiModalExecutionContext();
    });

    it('applyOutput sets providerOutput without multimodalArtifacts', () => {
        ctx.beginTurn('input1');
        ctx.applyOutput('output1');
        const turn = ctx.getHistory()[0];
        expect(turn.providerOutput).toBe('output1');
        expect(turn.multimodalArtifacts).toEqual({});
    });

    it('attachMultimodalArtifacts merges with existing artifacts', () => {
        ctx.beginTurn('input1');
        // Set initial artifacts
        ctx.attachMultimodalArtifacts({ foo: 1 });
        // Merge new artifacts
        ctx.attachMultimodalArtifacts({ bar: 2 });
        const turn = ctx.getHistory()[0];
        expect(turn.multimodalArtifacts).toMatchObject({ foo: 1, bar: 2 });
    });

    it('yieldArtifacts with no arguments does nothing', () => {
        ctx.beginTurn('input1');
        // Should not throw or change state
        ctx.yieldArtifacts();
        const turn = ctx.getHistory()[0];
        expect(turn.providerOutput).toBeUndefined();
        expect(turn.multimodalArtifacts).toEqual({});
    });    

    it('initializes with empty state', () => {
        expect(ctx.getHistory()).toEqual([]);
        expect(ctx.chatMessages).toEqual([]);
        expect(ctx.images).toEqual([]);
        expect(ctx.masks).toEqual([]);
        expect(ctx.artifacts).toEqual({});
    });

    it('beginTurn adds a turn to history', () => {
        ctx.beginTurn('input1');
        expect(ctx.getHistory().length).toBe(1);
        expect(ctx.getHistory()[0].input).toBe('input1');
    });

    it('applyOutput sets providerOutput and multimodalArtifacts', () => {
        ctx.beginTurn('input1');
        ctx.applyOutput('output1', { chat: [mockChatMsg], images: [mockImage], masks: [mockMask], foo: 42 });
        const turn = ctx.getHistory()[0];
        expect(turn.providerOutput).toBe('output1');
        expect(turn.multimodalArtifacts).toMatchObject({ chat: [mockChatMsg], images: [mockImage], masks: [mockMask], foo: 42 });
        expect(ctx.chatMessages).toContain(mockChatMsg);
        expect(ctx.images).toContain(mockImage);
        expect(ctx.masks).toContain(mockMask);
        expect(ctx.artifacts.foo).toBe(42);
    });

    it('attachMultimodalArtifacts merges artifacts and updates global state', () => {
        ctx.beginTurn('input1');
        ctx.attachMultimodalArtifacts({ chat: [mockChatMsg], images: [mockImage], foo: 99 });
        const turn = ctx.getHistory()[0];
        expect(turn.multimodalArtifacts).toMatchObject({ chat: [mockChatMsg], images: [mockImage], foo: 99 });
        expect(ctx.chatMessages).toContain(mockChatMsg);
        expect(ctx.images).toContain(mockImage);
        expect(ctx.artifacts.foo).toBe(99);
    });

    it('yieldArtifacts with output calls applyOutput', () => {
        ctx.beginTurn('input1');
        ctx.yieldArtifacts('out', { chat: [mockChatMsg] });
        const turn = ctx.getHistory()[0];
        expect(turn.providerOutput).toBe('out');
        expect(ctx.chatMessages).toContain(mockChatMsg);
    });

    it('yieldArtifacts with only artifacts calls attachMultimodalArtifacts', () => {
        ctx.beginTurn('input1');
        ctx.yieldArtifacts(undefined, { images: [mockImage] });
        expect(ctx.images).toContain(mockImage);
    });

    it('buildProviderInput returns current turn input', () => {
        ctx.beginTurn('foo');
        expect(ctx.buildProviderInput()).toBe('foo');
    });

    it('getHistory returns readonly array', () => {
        ctx.beginTurn('a');
        expect(Array.isArray(ctx.getHistory())).toBe(true);
        expect(() => { (ctx.getHistory() as any).push('bad'); }).not.toThrow(); // TS only
    });

    it('reset clears all state', () => {
        ctx.beginTurn('a');
        ctx.applyOutput('b', { chat: [mockChatMsg], images: [mockImage], masks: [mockMask], foo: 1 });
        ctx.reset();
        expect(ctx.getHistory()).toEqual([]);
        expect(ctx.chatMessages).toEqual([]);
        expect(ctx.images).toEqual([]);
        expect(ctx.masks).toEqual([]);
        expect(ctx.artifacts).toEqual({});
    });

    it('getLastChatMessage returns last chat message', () => {
        ctx.chatMessages.push(mockChatMsg, { role: 'assistant', content: [{ type: 'text', text: 'yo' }] });
        expect(ctx.getLastChatMessage()).toEqual({ role: 'assistant', content: [{ type: 'text', text: 'yo' }] });
    });

    it('getLastImage returns last image', () => {
        ctx.images.push(
            { url: 'a', mimeType: 'image/png', raw: {}, id: 'imgA' },
            { url: 'b', mimeType: 'image/png', raw: {}, id: 'imgB' }
        );
        expect(ctx.getLastImage()).toEqual({ url: 'b', mimeType: 'image/png', raw: {}, id: 'imgB' });
    });

    it('getLastMask returns last mask', () => {
        ctx.masks.push(
            { url: 'm1', mimeType: 'image/png', raw: {}, id: 'mask1' },
            { url: 'm2', mimeType: 'image/png', raw: {}, id: 'mask2' }
        );
        expect(ctx.getLastMask()).toEqual({ url: 'm2', mimeType: 'image/png', raw: {}, id: 'mask2' });
    });

    it('throws if applyOutput called before beginTurn', () => {
        expect(() => ctx.applyOutput('x')).toThrow('No active turn');
    });

    it('throws if attachMultimodalArtifacts called before beginTurn', () => {
        expect(() => ctx.attachMultimodalArtifacts({ foo: 1 })).toThrow('attachMultimodalArtifacts called before beginTurn');
    });

    it('throws if buildProviderInput called before beginTurn', () => {
        expect(() => ctx.buildProviderInput()).toThrow('No turn started');
    });
});
