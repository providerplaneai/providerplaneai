import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OpenAIImageGenerationCapabilityImpl } from '#root/providers/openai/capabilities/OpenAIImageGenerationCapabilityImpl.js';
import { AIProvider } from '#root/index.js';

const mockProvider = {
    ensureInitialized: vi.fn(),
    getMergedOptions: vi.fn((cap, opts) => ({ model: 'mock-model', modelParams: {}, providerParams: {}, generalParams: {} }))
};
const mockClient = {
    responses: {
        create: vi.fn(),
        stream: vi.fn()
    }
};

describe('OpenAIImageGenerationCapabilityImpl', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('throws if prompt is missing (non-streaming)', async () => {
        const gen = new OpenAIImageGenerationCapabilityImpl(mockProvider as any, mockClient as any);
        await expect(gen.generateImage({ input: {} } as any)).rejects.toThrow('Prompt is required for image generation');
    });

    it('returns normalized images for valid response (non-streaming)', async () => {
        mockClient.responses.create.mockResolvedValue({
            output: [
                { type: 'image_generation_call', result: 'imgdata', id: 'id1' },
                { type: 'image_generation_call', result: 'imgdata2', id: 'id2' }
            ],
            id: 'resp1',
            status: 'completed'
        });
        const gen = new OpenAIImageGenerationCapabilityImpl(mockProvider as any, mockClient as any);
        const req = { input: { prompt: 'draw a cat', params: { count: 1, size: '1024x1024' } } };
        const res = await gen.generateImage(req as any);
        expect(res.output.length).toBe(2);
        expect(res.output[0].base64).toBe('imgdata');
        expect(res.output[0].mimeType).toBe('image/png');
        expect(res.output[0].url).toBe(undefined);
        expect(res.metadata?.provider).toBe(AIProvider.OpenAI);
    });

    it('passes correct model, prompt, and config to responses.create', async () => {
        mockClient.responses.create.mockResolvedValue({ output: [], id: 'idX', status: 'completed' });
        mockProvider.getMergedOptions.mockReturnValueOnce({
            model: 'custom-model',
            modelParams: { temperature: 0.5 },
            providerParams: { foo: 'bar' },
            generalParams: {}
        });
        const gen = new OpenAIImageGenerationCapabilityImpl(mockProvider as any, mockClient as any);
        const req = { input: { prompt: 'draw', params: { count: 1, size: '1024x1024', style: 'art', quality: 'hd', background: 'white' } } };
        await gen.generateImage(req as any);
        expect(mockClient.responses.create).toHaveBeenCalledWith(expect.objectContaining({
            model: 'custom-model',
            input: [expect.objectContaining({ role: 'user', content: expect.any(Array) })],
            tools: [expect.objectContaining({ type: 'image_generation', size: '1024x1024', style: 'art', quality: 'hd', background: 'white' })],
            temperature: 0.5,
            foo: 'bar'
        }));
    });

    it('handles reference images in non-streaming', async () => {
        mockClient.responses.create.mockResolvedValue({ output: [], id: 'idX', status: 'completed' });
        const gen = new OpenAIImageGenerationCapabilityImpl(mockProvider as any, mockClient as any);
        const req = { input: { prompt: 'draw', referenceImages: [{ url: 'refurl' }], params: { count: 1 } } };
        await gen.generateImage(req as any);
        expect(mockClient.responses.create).toHaveBeenCalledWith(expect.objectContaining({
            input: [expect.objectContaining({ role: 'user', content: expect.arrayContaining([
                expect.objectContaining({ type: 'input_image', image_url: 'refurl' }),
                expect.objectContaining({ type: 'input_text', text: expect.any(String) })
            ]) })]
        }));
    });

    it('returns empty output if no image_generation_call items', async () => {
        mockClient.responses.create.mockResolvedValue({ output: [{ type: 'other_type', result: 'notimg', id: 'idOther' }], id: 'idOther', status: 'completed' });
        const gen = new OpenAIImageGenerationCapabilityImpl(mockProvider as any, mockClient as any);
        const req = { input: { prompt: 'draw', params: { count: 1 } } };
        const res = await gen.generateImage(req as any);
        expect(res.output).toEqual([]);
    });

    // Streaming tests
    it('throws if prompt is missing (streaming)', async () => {
        const gen = new OpenAIImageGenerationCapabilityImpl(mockProvider as any, mockClient as any);
        const genStream = gen.generateImageStream({ input: {} } as any);
        await expect(genStream.next()).rejects.toThrow('Prompt is required for image generation');
    });

    it('yields images for valid stream events', async () => {
        const fakeStream = {
            [Symbol.asyncIterator]: function () { return this; },
            next: async function () {
                if (!this._yielded) {
                    this._yielded = true;
                    return {
                        value: {
                            type: 'response.completed', response: {
                                output: [
                                    { type: 'image_generation_call', result: 'imgS', id: 'idS' }
                                ]
                            }
                        }, done: false
                    };
                }
                return { done: true };
            },
            _yielded: false
        };
        mockClient.responses.stream.mockReturnValue(fakeStream);
        const gen = new OpenAIImageGenerationCapabilityImpl(mockProvider as any, mockClient as any);
        const req = { input: { prompt: 'draw', params: { count: 1 } } };
        const stream = gen.generateImageStream(req as any);
        const chunk = await stream.next();
        expect(chunk.value.output[0].base64).toBe('imgS');
        expect(chunk.value.id).toBe('idS');
        expect(chunk.value.done).toBe(true);
        expect(chunk.value.metadata?.provider).toBe(AIProvider.OpenAI);
    });

    it('handles reference images in streaming', async () => {
        const fakeStream = {
            [Symbol.asyncIterator]: function () { return this; },
            next: async function () {
                if (!this._yielded) {
                    this._yielded = true;
                    return {
                        value: {
                            type: 'response.completed', response: {
                                output: [
                                    { type: 'image_generation_call', result: 'imgS', id: 'idS' }
                                ]
                            }
                        }, done: false
                    };
                }
                return { done: true };
            },
            _yielded: false
        };
        mockClient.responses.stream.mockReturnValue(fakeStream);
        const gen = new OpenAIImageGenerationCapabilityImpl(mockProvider as any, mockClient as any);
        const req = { input: { prompt: 'draw', referenceImages: [{ url: 'refurl' }], params: { count: 1 } } };
        const stream = gen.generateImageStream(req as any);
        const chunk = await stream.next();
        expect(chunk.value.output[0].base64).toBe('imgS');
        expect(chunk.value.id).toBe('idS');
    });

    it('yields error chunk if error thrown during stream iteration', async () => {
        const fakeStream = {
            [Symbol.asyncIterator]: function () { return this; },
            next: async function () {
                throw new Error('iteration error');
            }
        };
        mockClient.responses.stream.mockReturnValue(fakeStream);
        const gen = new OpenAIImageGenerationCapabilityImpl(mockProvider as any, mockClient as any);
        const req = { input: { prompt: 'draw', params: { count: 1 } } };
        const stream = gen.generateImageStream(req as any);
        const chunk = await stream.next();
        expect(chunk.value.error).toBe('iteration error');
        expect(chunk.value.done).toBe(true);
    });

    it('yields error chunk if non-Error thrown during stream iteration (covers String(err) branch)', async () => {
        const fakeStream = {
            [Symbol.asyncIterator]: function () { return this; },
            next: async function () {
                throw 'string error';
            }
        };
        mockClient.responses.stream.mockReturnValue(fakeStream);
        const gen = new OpenAIImageGenerationCapabilityImpl(mockProvider as any, mockClient as any);
        const req = { input: { prompt: 'draw', params: { count: 1 } } };
        const stream = gen.generateImageStream(req as any);
        const chunk = await stream.next();
        expect(chunk.value.error).toBe('string error');
        expect(chunk.value.done).toBe(true);
    });

    it('returns empty output if no image_generation_call items in stream', async () => {
        const fakeStream = {
            [Symbol.asyncIterator]: function () { return this; },
            next: async function () {
                if (!this._yielded) {
                    this._yielded = true;
                    return {
                        value: {
                            type: 'response.completed', response: {
                                output: [
                                    { type: 'other_type', result: 'notimg', id: 'idOther' }
                                ]
                            }
                        }, done: false
                    };
                }
                return { done: true };
            },
            _yielded: false
        };
        mockClient.responses.stream.mockReturnValue(fakeStream);
        const gen = new OpenAIImageGenerationCapabilityImpl(mockProvider as any, mockClient as any);
        const req = { input: { prompt: 'draw', params: { count: 1 } } };
        const stream = gen.generateImageStream(req as any);
        const chunk = await stream.next();
        expect(chunk.value).toBeUndefined();
    });
});
