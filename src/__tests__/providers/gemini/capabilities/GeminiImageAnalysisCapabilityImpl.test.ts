import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GeminiImageAnalysisCapabilityImpl } from '#root/providers/gemini/capabilities/GeminiImageAnalysisCapabilityImpl.js';
import { AIProvider } from '#root/index.js';

const mockProvider = {
    ensureInitialized: vi.fn(),
    getMergedOptions: vi.fn((cap, opts) => ({ model: 'mock-model', modelParams: {}, providerParams: {}, generalParams: {} }))
};
const mockClient = {
    models: {
        generateContent: vi.fn()
    }
};

describe('GeminiImageAnalysisCapabilityImpl', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('throws if no images are provided', async () => {
        const analysis = new GeminiImageAnalysisCapabilityImpl(mockProvider as any, mockClient as any);
        await expect(analysis.analyzeImage({ input: { images: [] } } as any)).rejects.toThrow('At least one image is required for analysis');
    });

    it('returns parsed analysis for valid image', async () => {
        const fakeResponse = { text: '{"description":"desc","tags":["a"]}', responseId: 'id1' };
        mockClient.models.generateContent.mockResolvedValue(fakeResponse);
        const analysis = new GeminiImageAnalysisCapabilityImpl(mockProvider as any, mockClient as any);
        const req = { input: { images: [{ base64: 'imgdata', id: 'img1' }] } };
        const res = await analysis.analyzeImage(req as any);
        expect(res.output[0].description).toBe('desc');
        expect(res.output[0].id).toBe('img1');
        expect(res.id).toBe('id1');
        expect(res.metadata?.provider).toBe(AIProvider.Gemini);
    });

    it('returns fallback description if JSON parse fails', async () => {
        mockClient.models.generateContent.mockResolvedValue({ text: 'not-json', responseId: 'id2' });
        const analysis = new GeminiImageAnalysisCapabilityImpl(mockProvider as any, mockClient as any);
        const req = { input: { images: [{ base64: 'imgdata', id: 'img2' }] } };
        const res = await analysis.analyzeImage(req as any);
        expect(res.output[0].description).toBe('not-json');
        expect(res.output[0].id).toBe('img2');
        expect(res.id).toBe('id2');
    });

    it('merges context metadata into response', async () => {
        mockClient.models.generateContent.mockResolvedValue({ text: '{"description":"desc"}', responseId: 'id3' });
        const analysis = new GeminiImageAnalysisCapabilityImpl(mockProvider as any, mockClient as any);
        const req = { input: { images: [{ base64: 'imgdata', id: 'img3' }] }, context: { requestId: 'req3', metadata: { foo: 'bar' } } };
        const res = await analysis.analyzeImage(req as any);
        expect(res.metadata?.requestId).toBe('req3');
        expect(res.metadata?.foo).toBe('bar');
    });

    it('handles multiple images, both parse success and failure', async () => {
        // First image: valid JSON, second: invalid JSON
        const responses = [
            { text: '{"description":"desc1"}', responseId: 'idA' },
            { text: 'not-json', responseId: 'idB' }
        ];
        let call = 0;
        mockClient.models.generateContent.mockImplementation(() => Promise.resolve(responses[call++]));
        const analysis = new GeminiImageAnalysisCapabilityImpl(mockProvider as any, mockClient as any);
        const req = { input: { images: [
            { base64: 'img1', id: 'imgA' },
            { base64: 'img2', id: 'imgB' }
        ] } };
        const res = await analysis.analyzeImage(req as any);
        expect(res.output[0].description).toBe('desc1');
        expect(res.output[0].id).toBe('imgA');
        expect(res.output[1].description).toBe('not-json');
        expect(res.output[1].id).toBe('imgB');
        // Should use first responseId for id
        expect(res.id).toBe('idA');
    });

    it('passes correct model, mimeType, and config to generateContent', async () => {
        mockClient.models.generateContent.mockResolvedValue({ text: '{"description":"desc"}', responseId: 'idX' });
        mockProvider.getMergedOptions.mockReturnValueOnce({
            model: 'custom-model',
            modelParams: { temperature: 0.5 },
            providerParams: { foo: 'bar' },
            generalParams: {}
        });
        const analysis = new GeminiImageAnalysisCapabilityImpl(mockProvider as any, mockClient as any);
        const req = { input: { images: [{ base64: 'img', id: 'imgX', mimeType: 'image/jpeg' }] } };
        await analysis.analyzeImage(req as any);
        expect(mockClient.models.generateContent).toHaveBeenCalledWith(expect.objectContaining({
            model: 'custom-model',
            contents: [expect.objectContaining({
                parts: expect.arrayContaining([
                    expect.objectContaining({ text: expect.any(String) }),
                    expect.objectContaining({ inlineData: expect.objectContaining({ mimeType: 'image/jpeg', data: 'img' }) })
                ])
            })],
            config: expect.objectContaining({ temperature: 0.5 }),
            foo: 'bar'
        }));
    });
});
