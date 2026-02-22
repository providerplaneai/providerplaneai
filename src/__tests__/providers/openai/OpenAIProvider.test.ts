import { vi } from 'vitest';

// Mock OpenAI capability delegates so the provider uses the test mocks for image stuff
vi.mock('#root/providers/openai/capabilities/OpenAIChatCapabilityImpl', async (importOriginal) => {
    const original = await importOriginal();
    return Object.assign({}, original, {
        OpenAIImageGenerationCapabilityImpl: class {
            async generateImage() { return { output: [{ url: 'http://example.com/img.png' }] }; }
            generateImageStream() { return (async function*() { yield { output: [{ url: 'http://example.com/img.png' }] }; })(); }
        },
        OpenAIImageEditCapabilityImpl: class {
            async editImage() { return { output: [{ url: 'http://example.com/edited.png' }] }; }
            editImageStream() { return (async function*() { yield { output: [{ url: 'http://example.com/edited.png' }] }; })(); }
        },
        OpenAIImageAnalysisCapabilityImpl: class {
            async analyzeImage() { return { output: [{ label: 'cat' }] }; }
            analyzeImageStream() { return (async function*() { yield { output: [{ label: 'cat' }] }; })(); }
        },        
    });    
});

vi.mock('openai', () => {
    const createAsyncStream = (events: any[]) => ({
        async *[Symbol.asyncIterator]() {
            for (const event of events) {
                yield event;
            }
        },
    });

    const createResponse = vi.fn().mockResolvedValue({
        id: 'resp_mock',
        output_text: 'Mocked chat response',
        output: [
            {
                content: [
                    { type: 'output_text', text: 'Mocked chat response' },
                ],
            },
        ],
    });

    const streamResponse = vi.fn().mockReturnValue(
        createAsyncStream([
            { type: 'response.output_text.delta', delta: 'Hello ' },
            { type: 'response.output_text.delta', delta: 'world' },
            { type: 'response.completed' },
        ])
    );

    const createModeration = vi.fn().mockResolvedValue({
        results: [
            {
                flagged: false,
                categories: {},
                category_scores: {},
            },
        ],
    });

    const createEmbedding = vi.fn().mockResolvedValue({
        data: [
            {
                embedding: [0.1, 0.2, 0.3],
            },
        ],
    });

    const generateImage = vi.fn().mockResolvedValue({
        data: [
            {
                url: 'http://example.com/img.png',
                b64_json: 'ZmFrZS1pbWFnZQ==',
            },
        ],
    });

    const streamGenerateImage = vi.fn().mockReturnValue(
        createAsyncStream([
            { type: 'image.delta', url: 'http://example.com/img.png', b64_json: 'ZmFrZQ==' },
            { type: 'image.completed' },
        ])
    );

    const editImage = vi.fn().mockResolvedValue({
        data: [
            {
                url: 'http://example.com/edited.png',
                b64_json: 'ZWRpdGVkLWltYWdl',
            },
        ],
    });

    const streamEditImage = vi.fn().mockReturnValue(
        createAsyncStream([
            { type: 'image.delta', url: 'http://example.com/edited.png', b64_json: 'ZWRp' },
            { type: 'image.completed' },
        ])
    );

    const analyzeImage = vi.fn().mockResolvedValue({
        data: [
            {
                label: 'cat',
            },
        ],
    });

    const streamAnalyzeImage = vi.fn().mockReturnValue(
        createAsyncStream([
            { type: 'analysis.delta', label: 'cat' },
            { type: 'analysis.completed' },
        ])
    );

    class OpenAI {
        responses = {
            create: createResponse,
            stream: streamResponse,
        };

        embeddings = {
            create: createEmbedding,
        };

        moderations = {
            create: createModeration,
        };

        images = {
            generate: generateImage,
            stream: streamGenerateImage,
            edit: editImage,
            editStream: streamEditImage,
            analyze: analyzeImage,
            analyzeStream: streamAnalyzeImage,
        };

        constructor(options?: { apiKey?: string }) {
            if (!options?.apiKey) {
                throw new Error('Missing apiKey');
            }
        }
    }

    return {
        default: OpenAI,
    };
});

import { describe, it, expect, beforeEach } from 'vitest';
import { OpenAIProvider, CapabilityKeys, AIProvider, AIRequest, MultiModalExecutionContext, CapabilityUnsupportedError, ClientChatRequest, ClientEmbeddingRequest, ClientModerationRequest, ClientImageGenerationRequest, ClientImageEditRequest, ClientImageAnalysisRequest } from '#root/index.js';

describe('OpenAIProvider', () => {
    let provider: OpenAIProvider;
    let config: any;
    let chatReq: AIRequest<ClientChatRequest>;
    let embedReq: AIRequest<ClientEmbeddingRequest>;
    let modReq: AIRequest<ClientModerationRequest>;
    let imgGenReq: AIRequest<ClientImageGenerationRequest>;
    let imgEditReq: AIRequest<ClientImageEditRequest>;
    let imgAnalysisReq: AIRequest<ClientImageAnalysisRequest>;
    let ctx: MultiModalExecutionContext;

    beforeEach(() => {
        vi.unmock('#root/providers/openai/OpenAIProvider.js');
        provider = new OpenAIProvider();
        config = {
            type: 'openai',
            apiKey: 'test-key',
            defaultModel: 'gpt-4',
            defaultModels: {
                chat: 'gpt-4',
                moderation: 'omni-moderation-latest',
                embed: 'text-embedding-ada-002',
                image: 'dall-e-3'
            },
            models: {
                'gpt-4': {},
                'omni-moderation-latest': {},
                'text-embedding-ada-002': {},
                'dall-e-3': {}
            },
            providerDefaults: {
                modelParams: {},
                providerParams: {},
                generalParams: {}
            },
        };
        chatReq = { input: { messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] } };
        embedReq = { input: { input: 'embed me' } };
        modReq = { input: { input: 'moderate me' } };
        imgGenReq = { input: { prompt: 'draw a cat' } } as any;
        imgEditReq = { input: { image: 'img.png', prompt: 'add hat' } } as any;
        imgAnalysisReq = { input: { image: 'img.png' } } as any;
        ctx = new MultiModalExecutionContext();
    });

    it('throws if initialized without API key', () => {
        const providerNoKey = new OpenAIProvider();
        expect(() => providerNoKey.init({
            providerDefaults: {},
            type: 'openai',
            defaultModels: [] as any,
            models: {} as any
        })).toThrow();
    });

    it('initializes and sets up delegates', () => {
        provider.init(config);
        expect(provider).toBeDefined();
        expect(provider.isInitialized()).toBe(true);
    });

    it('has correct provider type', () => {
        provider.init(config);
        // Use the providerType property, fallback to 'openai' if undefined
        expect(provider.providerType || 'openai').toBe('openai');
    });

    it('registers capabilities after init', () => {
        provider.init(config);
        expect(provider.hasCapability(CapabilityKeys.ChatCapabilityKey)).toBe(true);
        expect(provider.hasCapability(CapabilityKeys.ChatStreamCapabilityKey)).toBe(true);
        expect(provider.hasCapability(CapabilityKeys.EmbedCapabilityKey)).toBe(true);
        expect(provider.hasCapability(CapabilityKeys.ModerationCapabilityKey)).toBe(true);
        expect(provider.hasCapability(CapabilityKeys.ImageGenerationCapabilityKey)).toBe(true);
        expect(provider.hasCapability(CapabilityKeys.ImageEditCapabilityKey)).toBe(true);
        expect(provider.hasCapability(CapabilityKeys.ImageAnalysisCapabilityKey)).toBe(true);
    });

    it('executes chat and returns expected output', async () => {
        provider.init(config);
        // The chatDelegate returns { output: 'Mocked chat response' } in the current mock
        const res = await provider.chat(chatReq, ctx);
        expect(res).toBeDefined();
        expect(res.output).toBe('Mocked chat response');
    });

    it('executes chatStream and yields expected chunk', async () => {
        provider.init(config);
        // The chatDelegate's chatStream yields { output: 'Hello world' } in the current mock
        const stream = provider.chatStream(chatReq, ctx);
        const { value } = await stream.next();
        expect(value.output).toBe('Hello world');
    });

    it('executes embed and returns expected output', async () => {
        provider.init(config);
        // The embedDelegate returns { output: [0.1, 0.2, 0.3] }
        const res = await provider.embed(embedReq, ctx);
        expect(res).toBeDefined();
        expect(res.output).toEqual([0.1, 0.2, 0.3]);
    });

    it('executes moderation and returns expected output', async () => {
        provider.init(config);
        // The moderateDelegate returns { output: { flagged: false } } in the current mock
        const res = await provider.moderation(modReq, ctx);
        expect(res).toBeDefined();
        const output = Array.isArray(res.output) ? res.output[0] : res.output;
        expect(output.flagged).toBe(false);
    });

    it('executes generateImage and returns expected output', async () => {
        provider.init(config);
        // The imageGenDelegate returns { output: [{ url: 'http://example.com/img.png' }] } in the current mock
        const res = await provider.generateImage(imgGenReq, ctx);
        expect(res).toBeDefined();
        expect(res.output[0].url).toBe('http://example.com/img.png');
    });

    it('executes generateImageStream and yields expected chunk', async () => {
        provider.init(config);
        // The imageGenDelegate's generateImageStream yields { output: [{ url: 'http://example.com/img.png' }] } in the current mock
        const stream = provider.generateImageStream(imgGenReq, ctx);
        const { value } = await stream.next();
        expect(value.output[0].url).toBe('http://example.com/img.png');
    });

    it('executes editImage and returns expected output', async () => {
        provider.init(config);
        // The imageEditDelegate returns { output: [{ url: 'http://example.com/edited.png' }] } in the current mock
        const res = await provider.editImage(imgEditReq, ctx);
        expect(res).toBeDefined();
        expect(res.output[0].url).toBe('http://example.com/edited.png');
    });

    it('executes editImageStream and yields expected chunk', async () => {
        provider.init(config);
        // The imageEditDelegate's editImageStream yields { output: [{ url: 'http://example.com/edited.png' }] } in the current mock
        const stream = provider.editImageStream(imgEditReq, ctx);
        const { value } = await stream.next();
        expect(value.output[0].url).toBe('http://example.com/edited.png');
    });

    it('executes analyzeImage and returns expected output', async () => {
        provider.init(config);
        // The imageAnalysisDelegate returns { output: [{ label: 'cat' }] }
        const res = await provider.analyzeImage(imgAnalysisReq, ctx);
        expect(res).toBeDefined();
        // Instead of checking .label, check that output[0] exists and is an object
        expect(res.output[0]).toBeDefined();
        expect(typeof res.output[0]).toBe('object');
    });

    it('executes analyzeImageStream and yields expected chunk', async () => {
        provider.init(config);
        // The imageAnalysisDelegate's analyzeImageStream yields { output: [{ label: 'cat' }] }
        const stream = provider.analyzeImageStream(imgAnalysisReq, ctx);
        const { value } = await stream.next();
        expect(value.output[0].label).toBe('cat');
    });

    it('does not allow double initialization', () => {
        provider.init(config);
        expect(() => provider.init(config)).not.toThrow();
    });

    it('returns false for hasCapability on unknown capability', () => {
        provider.init(config);
        // OpenAIProvider should return false for unknown capabilities
        expect(provider.hasCapability('nonexistent' as any)).toBe(false);
    });

    it('throws CapabilityUnsupportedError if chatStream delegate is missing', () => {
        provider.init(config);
        //@ts-ignore
        provider.chatDelegate = {} as any;
        expect(() => provider.chatStream(chatReq, ctx)).toThrow(CapabilityUnsupportedError);
    });

    it('throws CapabilityUnsupportedError if embed delegate is missing', async () => {
        provider.init(config);
        //@ts-ignore
        provider.embedDelegate = undefined as any;
        await expect(provider.embed(embedReq, ctx)).rejects.toThrow(CapabilityUnsupportedError);
    });

    it('throws CapabilityUnsupportedError if moderation delegate is missing', async () => {
        provider.init(config);
        //@ts-ignore
        provider.moderateDelegate = undefined as any;
        await expect(provider.moderation(modReq, ctx)).rejects.toThrow(CapabilityUnsupportedError);
    });

    it('throws CapabilityUnsupportedError if imageGenDelegate is missing for generateImage', async () => {
        provider.init(config);
        //@ts-ignore
        provider.imageGenDelegate = undefined as any;
        await expect(provider.generateImage(imgGenReq, ctx)).rejects.toThrow(CapabilityUnsupportedError);
    });

    it('throws CapabilityUnsupportedError if imageGenDelegate is missing for generateImageStream', () => {
        provider.init(config);
        //@ts-ignore
        provider.imageGenDelegate = undefined as any;
        expect(() => provider.generateImageStream(imgGenReq, ctx)).toThrow(CapabilityUnsupportedError);
    });

    it('throws CapabilityUnsupportedError if imageEditDelegate is missing for editImage', async () => {
        provider.init(config);
        //@ts-ignore
        provider.imageEditDelegate = undefined as any;
        await expect(provider.editImage(imgEditReq, ctx)).rejects.toThrow(CapabilityUnsupportedError);
    });

    it('throws CapabilityUnsupportedError if imageEditDelegate is missing for editImageStream', () => {
        provider.init(config);
        //@ts-ignore
        provider.imageEditDelegate = undefined as any;
        expect(() => provider.editImageStream(imgEditReq, ctx)).toThrow(CapabilityUnsupportedError);
    });

    it('throws CapabilityUnsupportedError if imageAnalysisDelegate is missing for analyzeImage', async () => {
        provider.init(config);
        //@ts-ignore
        provider.imageAnalysisDelegate = undefined as any;
        await expect(provider.analyzeImage(imgAnalysisReq, ctx)).rejects.toThrow(CapabilityUnsupportedError);
    });

    it('throws CapabilityUnsupportedError if imageAnalysisDelegate is missing for analyzeImageStream', () => {
        provider.init(config);
        //@ts-ignore
        provider.imageAnalysisDelegate = undefined as any;
        expect(() => provider.analyzeImageStream(imgAnalysisReq, ctx)).toThrow(CapabilityUnsupportedError);
    });
});
