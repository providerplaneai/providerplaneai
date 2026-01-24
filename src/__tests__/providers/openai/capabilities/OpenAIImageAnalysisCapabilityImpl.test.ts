import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OpenAIImageAnalysisCapabilityImpl } from '#root/providers/openai/capabilities/OpenAIImageAnalysisCapabilityImpl.js';
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

describe('OpenAIImageAnalysisCapabilityImpl', () => {
    const defaultSchema = {
        type: "object",
        properties: {
            imageIndex: { type: "number", description: "Index of the analyzed image" },
            description: { type: "string", description: "Natural language description of the image" },
            tags: { type: "array", items: { type: "string" } },
            objects: {
                type: "array",
                items: {
                    type: "object",
                    properties: {
                        label: { type: "string" },
                        confidence: { type: "number" },
                        boundingBox: {
                            type: "object",
                            properties: {
                                x: { type: "number" },
                                y: { type: "number" },
                                width: { type: "number" },
                                height: { type: "number" }
                            },
                            required: ["x", "y", "width", "height"]
                        }
                    },
                    required: ["label"]
                }
            },
            text: {
                type: "array",
                items: {
                    type: "object",
                    properties: {
                        text: { type: "string" },
                        confidence: { type: "number" }
                    },
                    required: ["text"]
                }
            },
            safety: {
                type: "object",
                properties: {
                    flagged: { type: "boolean" },
                    categories: {
                        type: "object",
                        additionalProperties: { type: "boolean" }
                    }
                },
                required: ["flagged"]
            }
        },
        required: []
    };
    beforeEach(() => {
        vi.clearAllMocks();
        OpenAIImageAnalysisCapabilityImpl.OPENAI_IMAGE_ANALYSIS_SCHEMA = defaultSchema;
    });

    it('throws if no images are provided (analyzeImage)', async () => {
        const analysis = new OpenAIImageAnalysisCapabilityImpl(mockProvider as any, mockClient as any);
        await expect(analysis.analyzeImage({ input: { images: [] } } as any)).rejects.toThrow('At least one image is required for analysis');
    });

    it('throws if schema is invalid (analyzeImage)', async () => {
        const analysis = new OpenAIImageAnalysisCapabilityImpl(mockProvider as any, mockClient as any);
        OpenAIImageAnalysisCapabilityImpl.OPENAI_IMAGE_ANALYSIS_SCHEMA = {
            type: 'not-object',
            properties: defaultSchema.properties,
            required: []
        };
        await expect(analysis.analyzeImage({ input: { images: [{ base64: 'imgdata' }] } } as any)).rejects.toThrow("Invalid OpenAI function schema: root must be type 'object'");
    });

    it('returns parsed analysis for valid image', async () => {
        const fakeResponse = {
            output: [{ type: 'function_call', name: 'image_analysis', arguments: '{"description":"desc","imageIndex":0}' }],
            id: 'id1',
            status: 'completed'
        };
        mockClient.responses.create.mockResolvedValue(fakeResponse);
        const analysis = new OpenAIImageAnalysisCapabilityImpl(mockProvider as any, mockClient as any);
        const req = { input: { images: [{ base64: 'imgdata' }] } };
        const res = await analysis.analyzeImage(req as any);
        expect(res.output[0].description).toBe('desc');
        expect(res.id).toBe('id1');
        expect(res.metadata?.provider).toBe(AIProvider.OpenAI);
    });

    it('skips output items that are not function_call or wrong name', async () => {
        const fakeResponse = {
            output: [
                { type: 'not_function_call', name: 'image_analysis', arguments: '{}' },
                { type: 'function_call', name: 'other_tool', arguments: '{}' }
            ],
            id: 'id2',
            status: 'completed'
        };
        mockClient.responses.create.mockResolvedValue(fakeResponse);
        const analysis = new OpenAIImageAnalysisCapabilityImpl(mockProvider as any, mockClient as any);
        const req = { input: { images: [{ base64: 'imgdata' }] } };
        const res = await analysis.analyzeImage(req as any);
        expect(res.output).toEqual([]);
    });

    it('handles JSON parse error gracefully', async () => {
        const fakeResponse = {
            output: [{ type: 'function_call', name: 'image_analysis', arguments: 'not-json' }],
            id: 'id3',
            status: 'completed'
        };
        mockClient.responses.create.mockResolvedValue(fakeResponse);
        const analysis = new OpenAIImageAnalysisCapabilityImpl(mockProvider as any, mockClient as any);
        const req = { input: { images: [{ base64: 'imgdata' }] } };
        const res = await analysis.analyzeImage(req as any);
        expect(res.output).toEqual([]);
    });

    it('merges context metadata into response', async () => {
        const fakeResponse = {
            output: [{ type: 'function_call', name: 'image_analysis', arguments: '{"description":"desc"}' }],
            id: 'id4',
            status: 'completed'
        };
        mockClient.responses.create.mockResolvedValue(fakeResponse);
        const analysis = new OpenAIImageAnalysisCapabilityImpl(mockProvider as any, mockClient as any);
        const req = { input: { images: [{ base64: 'imgdata' }] }, context: { requestId: 'req4', metadata: { foo: 'bar' } } };
        const res = await analysis.analyzeImage(req as any);
        expect(res.metadata?.requestId).toBe('req4');
        expect(res.metadata?.foo).toBe('bar');
    });

    it('passes correct model, mimeType, and options to responses.create', async () => {
        mockClient.responses.create.mockResolvedValue({ output: [], id: 'idX', status: 'completed' });
        mockProvider.getMergedOptions.mockReturnValueOnce({
            model: 'custom-model',
            modelParams: { temperature: 0.5 },
            providerParams: { foo: 'bar' },
            generalParams: {}
        });
        const analysis = new OpenAIImageAnalysisCapabilityImpl(mockProvider as any, mockClient as any);
        const req = { input: { images: [{ base64: 'img', mimeType: 'image/jpeg' }] } };
        await analysis.analyzeImage(req as any);
        expect(mockClient.responses.create).toHaveBeenCalledWith(expect.objectContaining({
            model: 'custom-model',
            input: [expect.objectContaining({
                role: 'user', content: expect.arrayContaining([
                    expect.objectContaining({ type: 'input_image', image_url: expect.any(String) }),
                    expect.objectContaining({ type: 'input_text', text: expect.any(String) })
                ])
            })],
            tools: expect.any(Array),
            temperature: 0.5,
            foo: 'bar'
        }));
    });

    // Streaming tests
    it('throws if no images are provided (analyzeImageStream)', async () => {
        const analysis = new OpenAIImageAnalysisCapabilityImpl(mockProvider as any, mockClient as any);
        const gen = analysis.analyzeImageStream({ input: { images: [] } } as any);
        await expect(gen.next()).rejects.toThrow('At least one image is required for analysis');
    });

    it('yields error if schema is invalid (analyzeImageStream)', async () => {
        const analysis = new OpenAIImageAnalysisCapabilityImpl(mockProvider as any, mockClient as any);
        OpenAIImageAnalysisCapabilityImpl.OPENAI_IMAGE_ANALYSIS_SCHEMA = {
            type: 'not-object',
            properties: defaultSchema.properties,
            required: []
        };
        const gen = analysis.analyzeImageStream({ input: { images: [{ base64: 'imgdata' }] } } as any);
        await expect(gen.next()).rejects.toThrow("Invalid OpenAI function schema: root must be type 'object'");
    });

    it('yields parsed chunk for valid stream event', async () => {
        const fakeStream = {
            [Symbol.asyncIterator]: function () { return this; },
            next: async function () {
                if (!this._yielded) {
                    this._yielded = true;
                    return { value: { type: 'response.output_item.done', item: { type: 'function_call', name: 'image_analysis', arguments: '{"description":"desc"}', call_id: 'cid1' } }, done: false };
                }
                return { done: true };
            },
            _yielded: false
        };
        mockClient.responses.stream.mockResolvedValue(fakeStream);
        const analysis = new OpenAIImageAnalysisCapabilityImpl(mockProvider as any, mockClient as any);
        const req = { input: { images: [{ base64: 'imgdata' }] } };
        const gen = analysis.analyzeImageStream(req as any);
        const chunk = await gen.next();
        expect(chunk.value.output[0].description).toBe('desc');
        expect(chunk.value.id).toBe('cid1');
        expect(chunk.value.done).toBe(true);
        expect(chunk.value.metadata?.provider).toBe(AIProvider.OpenAI);
    });

    it('yields error chunk for JSON parse error in stream', async () => {
        const fakeStream = {
            [Symbol.asyncIterator]: function () { return this; },
            next: async function () {
                if (!this._yielded) {
                    this._yielded = true;
                    return { value: { type: 'response.output_item.done', item: { type: 'function_call', name: 'image_analysis', arguments: 'not-json', call_id: 'cid2' } }, done: false };
                }
                return { done: true };
            },
            _yielded: false
        };
        mockClient.responses.stream.mockResolvedValue(fakeStream);
        const analysis = new OpenAIImageAnalysisCapabilityImpl(mockProvider as any, mockClient as any);
        const req = { input: { images: [{ base64: 'imgdata' }] } };
        const gen = analysis.analyzeImageStream(req as any);
        const chunk = await gen.next();
        expect(chunk.value.error).toBe("Failed to parse image analysis output: Unexpected token 'o', \"not-json\" is not valid JSON");
        expect(chunk.value.done).toBe(true);
    });

    it('yields error chunk for thrown error in stream', async () => {
        mockClient.responses.stream.mockRejectedValue(new Error('stream error'));
        const analysis = new OpenAIImageAnalysisCapabilityImpl(mockProvider as any, mockClient as any);
        const req = { input: { images: [{ base64: 'imgdata' }] } };
        const gen = analysis.analyzeImageStream(req as any);
        const chunk = await gen.next();
        expect(chunk.value.error).toBe('stream error');
        expect(chunk.value.done).toBe(true);
    });

    it('returns empty output if response.output is undefined', async () => {
        mockClient.responses.create.mockResolvedValue({ id: 'idEmpty', status: 'completed' });
        const analysis = new OpenAIImageAnalysisCapabilityImpl(mockProvider as any, mockClient as any);
        const req = { input: { images: [{ base64: 'imgdata' }] } };
        const res = await analysis.analyzeImage(req as any);
        expect(res.output).toEqual([]);
        expect(res.id).toBe('idEmpty');
    });

    it('returns multiple analyses if response.output has multiple valid items', async () => {
        const fakeResponse = {
            output: [
                { type: 'function_call', name: 'image_analysis', arguments: '{"description":"desc1"}' },
                { type: 'function_call', name: 'image_analysis', arguments: '{"description":"desc2"}' }
            ],
            id: 'idMulti',
            status: 'completed'
        };
        mockClient.responses.create.mockResolvedValue(fakeResponse);
        const analysis = new OpenAIImageAnalysisCapabilityImpl(mockProvider as any, mockClient as any);
        const req = { input: { images: [{ base64: 'imgdata' }] } };
        const res = await analysis.analyzeImage(req as any);
        expect(res.output.length).toBe(2);
        expect(res.output[0].description).toBe('desc1');
        expect(res.output[1].description).toBe('desc2');
    });

    it('returns multiple analyses if arguments is an array', async () => {
        const fakeResponse = {
            output: [
                { type: 'function_call', name: 'image_analysis', arguments: '[{"description":"descA"},{"description":"descB"}]' }
            ],
            id: 'idArr',
            status: 'completed'
        };
        mockClient.responses.create.mockResolvedValue(fakeResponse);
        const analysis = new OpenAIImageAnalysisCapabilityImpl(mockProvider as any, mockClient as any);
        const req = { input: { images: [{ base64: 'imgdata' }] } };
        const res = await analysis.analyzeImage(req as any);
        expect(res.output.length).toBe(2);
        expect(res.output[0].description).toBe('descA');
        expect(res.output[1].description).toBe('descB');
    });

    it('stream yields empty output if no valid items', async () => {
        const fakeStream = {
            [Symbol.asyncIterator]: function () { return this; },
            next: async function () {
                if (!this._yielded) {
                    this._yielded = true;
                    return { value: { type: 'response.output_item.done', item: { type: 'not_function_call', name: 'image_analysis', arguments: '{}', call_id: 'cidX' } }, done: false };
                }
                return { done: true };
            },
            _yielded: false
        };
        mockClient.responses.stream.mockResolvedValue(fakeStream);
        const analysis = new OpenAIImageAnalysisCapabilityImpl(mockProvider as any, mockClient as any);
        const req = { input: { images: [{ base64: 'imgdata' }] } };
        const gen = analysis.analyzeImageStream(req as any);
        const chunk = await gen.next();
        expect(chunk.value.output).toEqual([]);
        expect(chunk.value.done).toBe(true);
    });

    it('stream yields multiple analyses if arguments is an array', async () => {
        const fakeStream = {
            [Symbol.asyncIterator]: function () { return this; },
            next: async function () {
                if (!this._yielded) {
                    this._yielded = true;
                    return { value: { type: 'response.output_item.done', item: { type: 'function_call', name: 'image_analysis', arguments: '[{"description":"descA"},{"description":"descB"}]', call_id: 'cidArr' } }, done: false };
                }
                return { done: true };
            },
            _yielded: false
        };
        mockClient.responses.stream.mockResolvedValue(fakeStream);
        const analysis = new OpenAIImageAnalysisCapabilityImpl(mockProvider as any, mockClient as any);
        const req = { input: { images: [{ base64: 'imgdata' }] } };
        const gen = analysis.analyzeImageStream(req as any);
        const chunk = await gen.next();
        expect(chunk.value.output.length).toBe(2);
        expect(chunk.value.output[0].description).toBe('descA');
        expect(chunk.value.output[1].description).toBe('descB');
        expect(chunk.value.id).toBe('cidArr');
        expect(chunk.value.done).toBe(true);
    });
});
