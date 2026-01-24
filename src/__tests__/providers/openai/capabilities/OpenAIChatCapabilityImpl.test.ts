import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OpenAIChatCapabilityImpl } from '#root/providers/openai/capabilities/OpenAIChatCapabilityImpl.js';
import { CapabilityKeys, AIProvider } from '#root/index.js';
import { BaseProvider } from '#root/core/provider/BaseProvider.js';

class MockProvider extends BaseProvider {
    ensureInitialized = vi.fn();
    getMergedOptions = vi.fn();
    constructor() { super('openai' as any); }
}

const mockClient = {
    responses: {
        create: vi.fn(),
        stream: vi.fn()
    }
};

describe('OpenAIChatCapabilityImpl', () => {
    let impl: OpenAIChatCapabilityImpl;
    let mockProvider: MockProvider;

    beforeEach(() => {
        mockProvider = new MockProvider();
        mockProvider.ensureInitialized.mockClear();
        mockProvider.getMergedOptions.mockClear();
        mockClient.responses.create.mockClear();
        mockClient.responses.stream.mockClear();
        impl = new OpenAIChatCapabilityImpl(mockProvider, mockClient as any);
    });

    it('chat returns output and metadata', async () => {
        mockProvider.getMergedOptions.mockReturnValue({ model: 'gpt-4', modelParams: {}, providerParams: {} });
        mockClient.responses.create.mockResolvedValue({ output_text: 'hi', id: 'id', status: 'completed', usage: { total_tokens: 1 } });
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
        expect(res.metadata?.provider).toBe(AIProvider.OpenAI);
    });

    it('chat throws if input messages are missing', async () => {
        await expect(impl.chat({ input: { messages: [] }, options: {} }, undefined)).rejects.toThrow('Received empty input messages');
    });

    it('chatStream yields all streaming events and final chunk', async () => {
        mockProvider.getMergedOptions.mockReturnValue({ model: 'gpt-4', modelParams: {}, providerParams: {}, generalParams: { chatStreamBatchSize: 2 } });
        // Simulate streaming events
        const events = [
            { type: 'response.output_text.delta', delta: 'h' },
            { type: 'response.output_text.delta', delta: 'i' },
            { type: 'response.output_text.delta', delta: '!' },
            { type: 'response.output_text.done' }
        ];
        const stream = {
            [Symbol.asyncIterator]: async function* () {
                for (const e of events) yield e;
            }
        };
        mockClient.responses.stream.mockReturnValue(stream);
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
        expect(chunks[0]).toMatchObject({ delta: 'hi', output: 'hi', done: false, id: undefined, metadata: expect.objectContaining({ status: 'incomplete' }) });
        // Second batch: '!' (buffer flush)
        expect(chunks[1]).toMatchObject({ delta: '!', output: '!', done: false, id: undefined, metadata: expect.objectContaining({ status: 'incomplete' }) });
        // Final chunk: accumulatedText = 'hi!'
        expect(chunks[2]).toMatchObject({ delta: '', output: 'hi!', done: true, id: undefined, metadata: expect.objectContaining({ status: 'completed' }) });
    });

    it('chatStream throws if input messages are missing', async () => {
        const gen = impl.chatStream({ input: { messages: [] }, options: {} }, undefined);
        await expect(gen.next()).rejects.toThrow('Received empty input messages');
    });

    it('chat throws on unsupported message part', async () => {
        mockProvider.getMergedOptions.mockReturnValue({ model: 'gpt-4', modelParams: {}, providerParams: {} });
        const badReq = {
            input: { messages: [{ role: 'user' as const, content: [{ type: 'foo', text: 'bad' }] }] },
            options: {}
        };
        await expect(impl.chat(badReq as any, undefined)).rejects.toThrow('foo part must have url or base64');
    });

    it('chat returns empty string if output_text is missing', async () => {
        mockProvider.getMergedOptions.mockReturnValue({ model: 'gpt-4', modelParams: {}, providerParams: {} });
        mockClient.responses.create.mockResolvedValue({ id: 'id', status: 'completed', usage: { total_tokens: 1 } });
        const req = {
            input: { messages: [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'hi' }] }] },
            options: {},
            context: { requestId: 'r1' }
        };
        const res = await impl.chat(req, undefined);
        expect(res.output).toBe('');
    });

    it('chatStream yields error chunk on error', async () => {
        mockProvider.getMergedOptions.mockReturnValue({ model: 'gpt-4', modelParams: {}, providerParams: {}, generalParams: {} });
        mockClient.responses.stream.mockImplementation(() => { throw new Error('fail'); });
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

    it('chatStream flushes buffer correctly with batchSize', async () => {
        mockProvider.getMergedOptions.mockReturnValue({ model: 'gpt-4', modelParams: {}, providerParams: {}, generalParams: { chatStreamBatchSize: 1 } });
        const events = [
            { type: 'response.output_text.delta', delta: 'A' },
            { type: 'response.output_text.delta', delta: 'B' },
            { type: 'response.output_text.delta', delta: 'C' },
            { type: 'response.output_text.done' }
        ];
        const stream = {
            [Symbol.asyncIterator]: async function* () {
                for (const e of events) yield e;
            }
        };
        mockClient.responses.stream.mockReturnValue(stream);
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
        expect(chunks[0].delta).toBe('A');
        expect(chunks[1].delta).toBe('B');
        expect(chunks[2].delta).toBe('C');
        expect(chunks[3].delta).toBe('');
        expect(chunks[3].output).toBe('ABC');
        expect(chunks[3].done).toBe(true);
    });

    it('mapParts throws for non-text part missing url/base64', () => {
        const badParts = [{ type: 'image', text: 'bad' }];
        expect(() => (impl as any).mapParts(badParts)).toThrow('image part must have url or base64');
    });

    it('mapParts throws for unsupported part type', () => {
        const badParts = [{ type: 'unsupported', url: 'http://example.com/file' }];
        expect(() => (impl as any).mapParts(badParts)).toThrow('Unsupported message part: unsupported');
    });

    it('mapParts returns correct OpenAI format for all supported types', () => {
        const parts = [
            { type: 'text', text: 'hello' },
            { type: 'image', url: 'http://img', mimeType: 'image/png' },
            { type: 'audio', url: 'http://audio', mimeType: 'audio/wav' },
            { type: 'video', url: 'http://video', mimeType: 'video/mp4' },
            { type: 'file', url: 'http://file', filename: 'f.txt', mimeType: 'text/plain' }
        ];
        const mapped = (impl as any).mapParts(parts);
        expect(mapped[0]).toEqual({ type: 'input_text', text: 'hello' });
        expect(mapped[1]).toEqual({ type: 'input_image', image_url: 'http://img' });
        expect(mapped[2]).toEqual({ type: 'input_audio', audio_url: 'http://audio' });
        expect(mapped[3]).toEqual({ type: 'input_video', video_url: 'http://video' });
        expect(mapped[4]).toEqual({ type: 'input_file', file_url: 'http://file', filename: 'f.txt', mime_type: 'text/plain' });
    });

    it('buildMessages returns correct format for OpenAI', () => {
        const messages = [
            { role: 'user', content: [ { type: 'text', text: 'hi' } ] },
            { role: 'assistant', content: [ { type: 'text', text: 'hello' } ] }
        ];
        const built = (impl as any).buildMessages(messages);
        expect(built).toEqual([
            { role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
            { role: 'assistant', content: [{ type: 'input_text', text: 'hello' }] }
        ]);
    });
});
