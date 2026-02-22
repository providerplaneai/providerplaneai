vi.mock("#root/core/utils/SharedUtils.js", async () => {
    const actual = await vi.importActual<any>("#root/core/utils/SharedUtils.js");
    return {
        ...actual,
        resolveImageToBytes: vi.fn().mockResolvedValue(Buffer.from([1,2,3]))
    };
});

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GeminiImageGenerationCapabilityImpl } from '#root/providers/gemini/capabilities/GeminiImageGenerationCapabilityImpl.js';
import { AIProvider } from '#root/index.js';
import * as SharedUtils from '#root/core/utils/SharedUtils.js';

const mockProvider = {
    ensureInitialized: vi.fn(),
    getMergedOptions: vi.fn((cap, opts) => ({ model: 'mock-model', modelParams: {}, providerParams: {}, generalParams: {} }))
};
const mockClient = {
    models: {
        generateImages: vi.fn()
    }
};

describe('GeminiImageGenerationCapabilityImpl', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('throws if prompt is missing', async () => {
        const gen = new GeminiImageGenerationCapabilityImpl(mockProvider as any, mockClient as any);
        await expect(gen.generateImage({ input: {} } as any)).rejects.toThrow();
    });

    it('returns normalized images for valid response', async () => {
        mockClient.models.generateImages.mockResolvedValue({
            generatedImages: [
                { image: { imageBytes: Buffer.from('imgdata'), mimeType: 'image/png' }, url: 'url1' },
                { image: { imageBytes: Buffer.from('imgdata2'), mimeType: 'image/jpeg' }, url: 'url2' }
            ]
        });
        const gen = new GeminiImageGenerationCapabilityImpl(mockProvider as any, mockClient as any);
        const req = { input: { prompt: 'draw a cat', params: { count: 2, size: '1536x1024' } } };
        const res = await gen.generateImage(req as any);
        expect(res.output.length).toBe(2);
        expect(res.output[0].url).toBe(undefined); // url is always undefined in normalized output
        expect(res.output[0].mimeType).toBe('image/png');
        expect(res.output[1].mimeType).toBe('image/jpeg');
        expect(res.metadata?.provider).toBe(AIProvider.Gemini);
    });

    it('passes correct model, prompt, and config to generateImages', async () => {
        mockClient.models.generateImages.mockResolvedValue({
            generatedImages: [
                { image: { imageBytes: Buffer.from('img'), mimeType: 'image/png' } }
            ]
        });
        mockProvider.getMergedOptions.mockReturnValueOnce({
            model: 'custom-model',
            modelParams: { temperature: 0.5 },
            providerParams: { foo: 'bar' },
            generalParams: {}
        });
        const gen = new GeminiImageGenerationCapabilityImpl(mockProvider as any, mockClient as any);
        const req = { input: { prompt: 'draw', params: { count: 1, size: '1536x1024' } } };
        await gen.generateImage(req as any);
        expect(mockClient.models.generateImages).toHaveBeenCalledWith(expect.objectContaining({
            model: 'custom-model',
            prompt: 'draw',
            config: expect.objectContaining({
                numberOfImages: 1,
                aspectRatio: '4:3',
                includeRaiReason: true,
                personGeneration: 'allow_adult',
                referenceImageWeight: 'HIGH'
            })
        }));
    });

    it('handles reference images and injects tags', async () => {
        // Mock resolveImageToBytes to always return a dummy Buffer
        const spy = vi.spyOn(SharedUtils, "resolveImageToBytes").mockResolvedValue(Buffer.from([1,2,3]));
        mockClient.models.generateImages.mockResolvedValue({ generatedImages: [{ image: { imageBytes: Buffer.from([1,2,3]), mimeType: 'image/png' } }] });
        const gen = new GeminiImageGenerationCapabilityImpl(mockProvider as any, mockClient as any);
        const req = { input: { prompt: 'draw', referenceImages: [{ base64: 'img', weight: 0.8 }], params: { size: '1536x1024' } } };
        await gen.generateImage(req as any);
        expect(mockClient.models.generateImages).toHaveBeenCalledWith(expect.objectContaining({
            referenceImages: expect.any(Array),
            prompt: expect.stringMatching(/\[1\]/)
        }));
        spy.mockRestore();
    });

    it('maps size to aspect ratio and weight', async () => {
        mockClient.models.generateImages.mockResolvedValue({ generatedImages: [{ data: 'img', mimeType: 'image/png', url: 'url' }] });
        const gen = new GeminiImageGenerationCapabilityImpl(mockProvider as any, mockClient as any);
        // @ts-expect-error: private method
        expect(gen.mapSizeToImagenAspectRatio('1536x1024')).toBe('4:3');
        // @ts-expect-error: private method
        expect(gen.mapWeight(0.1)).toBe('LOW');
        // @ts-expect-error: private method
        expect(gen.mapWeight(0.6)).toBe('MEDIUM');
        // @ts-expect-error: private method
        expect(gen.mapWeight(0.95)).toBe('HIGH');
    });

    it('injects reference tags into prompt', () => {
        const gen = new GeminiImageGenerationCapabilityImpl(mockProvider as any, mockClient as any);
        // @ts-expect-error: private method
        expect(gen.injectReferenceTags('draw', 2)).toMatch(/\[1\].*\[2\]/);
    });

    it('handles reference image bytes and mimeType', async () => {
        // Patch resolveImageToBytes to return a Uint8Array
        const fakeBytes = new Uint8Array([1,2,3]);
        // Use vi.stubGlobal for ESM default import mocking
        const mod = await import('#root/index.js');
        const orig = mod.resolveImageToBytes;
        mod.resolveImageToBytes = vi.fn().mockResolvedValue(fakeBytes);
        mockClient.models.generateImages.mockResolvedValue({ generatedImages: [{ image: { imageBytes: fakeBytes, mimeType: 'image/png' } }] });
        const gen = new GeminiImageGenerationCapabilityImpl(mockProvider as any, mockClient as any);
        const req = { input: { prompt: 'draw', referenceImages: [{ base64: 'img', mimeType: 'image/png' }] } };
        const res = await gen.generateImage(req as any);
        expect(res.output[0].base64).toBe(Buffer.from(fakeBytes).toString('base64'));
        mod.resolveImageToBytes = orig;
    });

    it('handles missing image fields gracefully', async () => {
        mockClient.models.generateImages.mockResolvedValue({ generatedImages: [{}] });
        const gen = new GeminiImageGenerationCapabilityImpl(mockProvider as any, mockClient as any);
        const req = { input: { prompt: 'draw' } };
        // Patch Buffer.from to handle undefined safely for this test
        const origBufferFrom = Buffer.from;
        Buffer.from = ((input: any, ...args: any[]) => {
            if (input === undefined) return Buffer.alloc(0);
            // @ts-ignore
            return origBufferFrom(input, ...args);
        }) as any;
        const res = await gen.generateImage(req as any);
        expect(res.output[0].base64).toBe('');
        Buffer.from = origBufferFrom;
    });

    it('returns empty array if no generatedImages', async () => {
        mockClient.models.generateImages.mockResolvedValue({ generatedImages: undefined });
        const gen = new GeminiImageGenerationCapabilityImpl(mockProvider as any, mockClient as any);
        const req = { input: { prompt: 'draw' } };
        const res = await gen.generateImage(req as any);
        expect(res.output).toEqual([]);
    });

    it('mapSizeToImagenAspectRatio returns label if already valid', () => {
        const gen = new GeminiImageGenerationCapabilityImpl(mockProvider as any, mockClient as any);
        // @ts-expect-error: private method
        expect(gen.mapSizeToImagenAspectRatio('4:3')).toBe('4:3');
    });

    it('mapSizeToImagenAspectRatio returns 1:1 for zero width or height', () => {
        const gen = new GeminiImageGenerationCapabilityImpl(mockProvider as any, mockClient as any);
        // @ts-expect-error: private method
        expect(gen.mapSizeToImagenAspectRatio('0x1024')).toBe('1:1');
        // @ts-expect-error: private method
        expect(gen.mapSizeToImagenAspectRatio('1536x0')).toBe('1:1');
    });
});
