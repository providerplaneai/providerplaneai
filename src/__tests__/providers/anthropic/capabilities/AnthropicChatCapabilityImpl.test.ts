import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AnthropicChatCapabilityImpl } from '#root/providers/anthropic/capabilities/AnthropicChatCapabilityImpl.js';
import { CapabilityKeys, AIProvider } from '#root/index.js';
import { BaseProvider } from '#root/core/provider/BaseProvider.js';

class MockProvider extends BaseProvider {
    ensureInitialized = vi.fn();
    getMergedOptions = vi.fn();
    constructor() { super('anthropic' as any); }
    // No need to implement init for these tests
}

const mockClient = {
    messages: {
        create: vi.fn(),
        stream: vi.fn()
    }
};

describe('AnthropicChatCapabilityImpl', () => {
    let impl: AnthropicChatCapabilityImpl;
    let mockProvider: MockProvider;
    beforeEach(() => {
        mockProvider = new MockProvider();
        mockProvider.ensureInitialized.mockClear();
        mockProvider.getMergedOptions.mockClear();
        mockClient.messages.create.mockClear();
        mockClient.messages.stream.mockClear();
        impl = new AnthropicChatCapabilityImpl(mockProvider, mockClient as any);
    });

    it('chatStream yields all streaming events and final chunk', async () => {
        mockProvider.getMergedOptions.mockReturnValue({ model: 'claude', modelParams: {}, providerParams: {}, generalParams: { chatStreamBatchSize: 2 } });
        // Simulate streaming events
        const events = [
            { type: 'message_start', message: { id: 'msgid' } },
            { type: 'content_block_delta', delta: { type: 'text_delta', text: 'h' } },
            { type: 'content_block_delta', delta: { type: 'text_delta', text: 'i' } },
            { type: 'content_block_delta', delta: { type: 'text_delta', text: '!' } }
        ];
        const stream = {
            [Symbol.asyncIterator]: async function* () {
                for (const e of events) yield e;
            },
            finalMessage: async () => ({ stop_reason: 'end_turn' })
        };
        mockClient.messages.stream.mockReturnValue(stream);
        const req = {
            input: { messages: [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'hi' }] }] },
            options: {},
            context: { requestId: 'r1' }
        };
        const gen = impl.chatStream(req, undefined);
        const chunks = [];
        for await (const chunk of gen) {
            chunks.push(chunk);
        }
        // First batch: 'hi' (batchSize=2)
        expect(chunks[0]).toMatchObject({ delta: 'hi', output: 'hi', done: false, id: 'msgid', metadata: expect.objectContaining({ status: 'incomplete' }) });
        // Second batch: '!' (buffer flush)
        expect(chunks[1]).toMatchObject({ delta: '!', output: '!', done: false, id: 'msgid', metadata: expect.objectContaining({ status: 'incomplete' }) });
        // Final chunk: accumulatedText = 'hi!'
        expect(chunks[2]).toMatchObject({ delta: '', output: 'hi!', done: true, id: 'msgid', metadata: expect.objectContaining({ status: 'completed' }) });
    });

    it('throws if input messages are missing (chat)', async () => {
        await expect(impl.chat({ input: { messages: [] }, options: {} }, undefined)).rejects.toThrow('Received empty input messages');
    });

    it('calls provider.ensureInitialized and getMergedOptions (chat)', async () => {
        mockProvider.getMergedOptions.mockReturnValue({ model: 'claude', modelParams: {}, providerParams: {} });
        mockClient.messages.create.mockResolvedValue({ id: 'id', content: [{ type: 'text', text: 'hi' }], usage: { output_tokens: 1 }, stop_reason: 'end_turn' });
        const req = {
            input: { messages: [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'hi' }] }] },
            options: {},
            context: { requestId: 'r1' }
        };
        const res = await impl.chat(req, undefined);
        expect(mockProvider.ensureInitialized).toHaveBeenCalled();
        expect(mockProvider.getMergedOptions).toHaveBeenCalledWith(CapabilityKeys.ChatCapabilityKey, req.options);
        expect(res.output).toBe('hi');
        expect(res.id).toBe('id');
        expect(res.metadata?.provider).toBe(AIProvider.Anthropic);
    });

    it('extractText returns concatenated text', () => {
        expect(impl["extractText"]({ content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }, { type: 'notext', text: 'c' }] })).toBe('ab');
    });

    it('buildMessages maps messages', () => {
        const msgs = [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'hi' }] }];
        expect(impl["buildMessages"](msgs)).toEqual([{ role: 'user', content: [{ type: 'text', text: 'hi' }] }]);
    });

    it('mapParts throws on unsupported type', () => {
        expect(() => impl["mapParts"]([{ type: 'image' }])).toThrow('Unsupported Anthropic chat part: image');
    });

    it('normalizeAnthropicStatus maps stop reasons', () => {
        expect(impl["normalizeAnthropicStatus"]('max_tokens')).toBe('incomplete');
        expect(impl["normalizeAnthropicStatus"]('pause_turn')).toBe('incomplete');
        expect(impl["normalizeAnthropicStatus"]('end_turn')).toBe('completed');
        expect(impl["normalizeAnthropicStatus"]('stop_sequence')).toBe('completed');
        expect(impl["normalizeAnthropicStatus"]('tool_use')).toBe('completed');
        expect(impl["normalizeAnthropicStatus"]('refusal')).toBe('completed');
        expect(impl["normalizeAnthropicStatus"](null)).toBe('completed');
        expect(impl["normalizeAnthropicStatus"](undefined)).toBe('completed');
    });

    it('chatStream throws if input messages are missing', async () => {
        const gen = impl.chatStream({ input: { messages: [] }, options: {} }, undefined);
        await expect(gen.next()).rejects.toThrow('Received empty input messages');
    });

    it('chatStream yields error chunk on error', async () => {
        mockProvider.getMergedOptions.mockReturnValue({ model: 'claude', modelParams: {}, providerParams: {}, generalParams: {} });
        mockClient.messages.stream.mockImplementation(() => { throw new Error('fail'); });
        const req = {
            input: { messages: [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'hi' }] }] },
            options: {},
            context: { requestId: 'r1' }
        };
        const gen = impl.chatStream(req, undefined);
        const { value } = await gen.next();
        expect(value.done).toBe(true);
        expect(value.metadata.status).toBe('error');
    });
});
