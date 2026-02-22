import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GeminiChatCapabilityImpl } from '#root/providers/gemini/capabilities/GeminiChatCapabilityImpl.js';
import { CapabilityKeys, AIProvider } from '#root/index.js';
import { BaseProvider } from '#root/core/provider/BaseProvider.js';

const mockProvider = {
    ensureInitialized: vi.fn(),
    getMergedOptions: vi.fn((cap, opts) => ({ model: 'mock-model', modelParams: {}, providerParams: {}, generalParams: {} }))
};
const mockClient = {
    models: {
        generateContent: vi.fn(),
        generateContentStream: vi.fn()
    }
};

describe('GeminiChatCapabilityImpl', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('throws if input messages are missing (chat)', async () => {
        const chat = new GeminiChatCapabilityImpl(mockProvider as any, mockClient as any);
        await expect(chat.chat({ input: { messages: [] } } as any)).rejects.toThrow('Received empty input messages');
    });

    it('returns normalized response from chat', async () => {
        mockClient.models.generateContent.mockResolvedValue({ text: 'hello', responseId: 'id123' });
        const chat = new GeminiChatCapabilityImpl(mockProvider as any, mockClient as any);
        const req = { input: { messages: [{ content: [{ type: 'text', text: 'hi' }] }] } };
        const res = await chat.chat(req as any);
        expect(res.output).toBe('hello');
        expect(res.id).toBe('id123');
        expect(res.metadata?.provider).toBe(AIProvider.Gemini);
    });

    it('throws if input messages are missing (chatStream)', async () => {
        const chat = new GeminiChatCapabilityImpl(mockProvider as any, mockClient as any);
        await expect(async () => {
            for await (const _ of chat.chatStream({ input: { messages: [] } } as any)) { }
        }).rejects.toThrow('Received empty input messages');
    });

    it('yields streaming chunks and final chunk (chatStream)', async () => {
        // Simulate async generator for streaming
        async function* fakeStream() {
            yield { text: 'abc', responseId: 'r1' };
            yield { text: 'def', responseId: 'r1' };
        }
        mockClient.models.generateContentStream.mockResolvedValue(fakeStream());
        const chat = new GeminiChatCapabilityImpl(mockProvider as any, mockClient as any);
        const req = { input: { messages: [{ content: [{ type: 'text', text: 'hi' }] }] } };
        const chunks = [];
        for await (const chunk of chat.chatStream(req as any)) {
            chunks.push(chunk);
        }
        // Should yield two partials and one final chunk
        expect(chunks.length).toBeGreaterThanOrEqual(2);
        expect(chunks[chunks.length - 1].done).toBe(true);
        expect(chunks[0].output).toContain('abc');
    });

    it('yields error chunk if streaming throws', async () => {
        mockClient.models.generateContentStream.mockRejectedValue(new Error('fail'));
        const chat = new GeminiChatCapabilityImpl(mockProvider as any, mockClient as any);
        const req = { input: { messages: [{ content: [{ type: 'text', text: 'hi' }] }] } };
        const chunks = [];
        for await (const chunk of chat.chatStream(req as any)) {
            chunks.push(chunk);
        }
        expect(chunks[chunks.length - 1].metadata?.status).toBe('error');
        expect(chunks[chunks.length - 1].done).toBe(true);
    });

    it('buildContents returns only text parts', () => {
        const chat = new GeminiChatCapabilityImpl(mockProvider as any, mockClient as any);
        const messages = [
            {
                content: [
                    { type: 'text', text: 'foo' },
                    { type: 'image', url: 'bar' },
                    { type: 'text', text: 'baz' }
                ]
            }
        ];
        // @ts-expect-error: private method
        const result = chat.buildContents(messages);
        expect(result).toBe('foo baz');
    });

    it('normalizeGeminiStatus returns correct status', () => {
        const chat = new GeminiChatCapabilityImpl(mockProvider as any, mockClient as any);
        // @ts-expect-error: private method
        expect(chat.normalizeGeminiStatus('MAX_TOKENS')).toBe('incomplete');
        // @ts-expect-error: private method
        expect(chat.normalizeGeminiStatus(undefined)).toBe('completed');
        // @ts-expect-error: private method
        expect(chat.normalizeGeminiStatus(null)).toBe('completed');
        // @ts-expect-error: private method
        expect(chat.normalizeGeminiStatus('other')).toBe('completed');
    });

    it('yields remaining buffer if not empty (chatStream)', async () => {
        // Simulate a stream that yields a single chunk less than batchSize
        async function* fakeStream() {
            yield { text: 'short', responseId: 'r2' };
        }
        mockClient.models.generateContentStream.mockResolvedValue(fakeStream());
        const chat = new GeminiChatCapabilityImpl(mockProvider as any, mockClient as any);
        const req = { input: { messages: [{ content: [{ type: 'text', text: 'hi' }] }] } };
        // Set batchSize to a large value to force buffer < batchSize
        mockProvider.getMergedOptions.mockReturnValueOnce({ model: 'mock-model', modelParams: {}, providerParams: {}, generalParams: { chatStreamBatchSize: 100 } });
        const chunks = [];
        for await (const chunk of chat.chatStream(req as any)) {
            chunks.push(chunk);
        }
        // Should yield the buffer as a chunk and a final chunk
        expect(chunks.length).toBe(2);
        expect(chunks[0].output).toBe('short');
        expect(chunks[1].done).toBe(true);
    });

    it('yields multiple partials if buffer reaches batchSize (chatStream)', async () => {
        // Simulate a stream that yields enough text to trigger multiple partials
        async function* fakeStream() {
            yield { text: 'a'.repeat(10), responseId: 'r3' };
            yield { text: 'b'.repeat(10), responseId: 'r3' };
        }
        mockClient.models.generateContentStream.mockResolvedValue(fakeStream());
        const chat = new GeminiChatCapabilityImpl(mockProvider as any, mockClient as any);
        const req = { input: { messages: [{ content: [{ type: 'text', text: 'hi' }] }] } };
        // Set batchSize to 10
        mockProvider.getMergedOptions.mockReturnValueOnce({ model: 'mock-model', modelParams: {}, providerParams: {}, generalParams: { chatStreamBatchSize: 10 } });
        const chunks = [];
        for await (const chunk of chat.chatStream(req as any)) {
            chunks.push(chunk);
        }
        // Should yield 2 partials and a final chunk
        expect(chunks.length).toBe(3);
        expect(chunks[0].output).toBe('a'.repeat(10));
        expect(chunks[1].output).toBe('b'.repeat(10));
        expect(chunks[2].done).toBe(true);
    });

    it('skips empty delta chunks in chatStream', async () => {
        async function* fakeStream() {
            yield { text: '', responseId: 'r4' };
            yield { text: 'real', responseId: 'r4' };
        }
        mockClient.models.generateContentStream.mockResolvedValue(fakeStream());
        const chat = new GeminiChatCapabilityImpl(mockProvider as any, mockClient as any);
        const req = { input: { messages: [{ content: [{ type: 'text', text: 'hi' }] }] } };
        const chunks = [];
        for await (const chunk of chat.chatStream(req as any)) {
            chunks.push(chunk);
        }
        // Only the non-empty chunk and final chunk should be yielded
        expect(chunks.length).toBe(2);
        expect(chunks[0].output).toBe('real');
        expect(chunks[1].done).toBe(true);
    });

    it('final chunk status uses finishReason (chatStream)', async () => {
        // Simulate a stream with a finishReason
        async function* fakeStream() {
            yield { text: 'done', responseId: 'r5' };
        }
        const streamObj = fakeStream();
        // Attach finishReason to the stream object
        (streamObj as any).finishReason = 'MAX_TOKENS';
        mockClient.models.generateContentStream.mockResolvedValue(streamObj);
        const chat = new GeminiChatCapabilityImpl(mockProvider as any, mockClient as any);
        const req = { input: { messages: [{ content: [{ type: 'text', text: 'hi' }] }] } };
        const chunks = [];
        for await (const chunk of chat.chatStream(req as any)) {
            chunks.push(chunk);
        }
        // The final chunk should have status 'incomplete'
        expect(chunks[chunks.length - 1].metadata?.status).toBe('incomplete');
    });
});
