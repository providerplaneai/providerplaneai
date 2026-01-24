import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GeminiEmbedCapabilityImpl } from '#root/providers/gemini/capabilities/GeminiEmbedCapabilityImpl.js';
import { AIProvider, CapabilityKeys } from '#root/index.js';

const mockProvider = {
    ensureInitialized: vi.fn(),
    getMergedOptions: vi.fn((cap, opts) => ({ model: 'mock-model', modelParams: {}, providerParams: {}, generalParams: {} }))
};
const mockClient = {
    models: {
        embedContent: vi.fn()
    }
};

describe('GeminiEmbedCapabilityImpl', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('throws if input is missing', async () => {
        const embed = new GeminiEmbedCapabilityImpl(mockProvider as any, mockClient as any);
        await expect(embed.embed({ input: undefined } as any)).rejects.toThrow('Invalid embedding input');
    });

    it('throws if API returns no embeddings', async () => {
        mockClient.models.embedContent.mockResolvedValue({ embeddings: [] });
        const embed = new GeminiEmbedCapabilityImpl(mockProvider as any, mockClient as any);
        await expect(embed.embed({ input: { input: 'foo' } } as any)).rejects.toThrow('API returned no embeddings');
    });

    it('throws if all embedding values are undefined', async () => {
        mockClient.models.embedContent.mockResolvedValue({ embeddings: [{ values: undefined }] });
        const embed = new GeminiEmbedCapabilityImpl(mockProvider as any, mockClient as any);
        await expect(embed.embed({ input: { input: 'foo' } } as any)).rejects.toThrow('API returned embeddings but all values were undefined');
    });

    it('returns normalized embedding response for single input', async () => {
        mockClient.models.embedContent.mockResolvedValue({ embeddings: [{ values: [1, 2, 3] }] });
        const embed = new GeminiEmbedCapabilityImpl(mockProvider as any, mockClient as any);
        const res = await embed.embed({ input: { input: 'foo' } } as any);
        expect(res.output).toEqual([1, 2, 3]);
        expect(res.metadata?.provider).toBe(AIProvider.Gemini);
    });

    it('returns normalized embedding response for multiple inputs', async () => {
        mockClient.models.embedContent.mockResolvedValue({ embeddings: [{ values: [1, 2, 3] }, { values: [4, 5, 6] }] });
        const embed = new GeminiEmbedCapabilityImpl(mockProvider as any, mockClient as any);
        const res = await embed.embed({ input: { input: ['foo', 'bar'] } } as any);
        expect(res.output).toEqual([[1, 2, 3], [4, 5, 6]]);
        expect(res.metadata?.provider).toBe(AIProvider.Gemini);
    });

    it('passes correct model and config to embedContent (custom options)', async () => {
        mockClient.models.embedContent.mockResolvedValue({ embeddings: [{ values: [1] }] });
        // Patch mockProvider.getMergedOptions to return the custom options
        mockProvider.getMergedOptions.mockReturnValueOnce({
            model: 'custom',
            modelParams: { taskType: 'CLASSIFICATION', dimensions: 128 },
            providerParams: {},
            generalParams: {}
        });
        const embed = new GeminiEmbedCapabilityImpl(mockProvider as any, mockClient as any);
        const req = { input: { input: 'foo' }, options: { model: 'custom', modelParams: { taskType: 'CLASSIFICATION', dimensions: 128 } } };
        await embed.embed(req as any);
        expect(mockClient.models.embedContent).toHaveBeenCalledWith(expect.objectContaining({
            model: 'custom',
            contents: [{ parts: [{ text: 'foo' }] }],
            config: expect.objectContaining({ taskType: 'CLASSIFICATION', outputDimensionality: 128 })
        }));
    });

    it('uses default model and config if not provided', async () => {
        mockClient.models.embedContent.mockResolvedValue({ embeddings: [{ values: [1] }] });
        // Patch mockProvider.getMergedOptions to return defaults
        mockProvider.getMergedOptions.mockReturnValueOnce({
            model: undefined as any,
            modelParams: {},
            providerParams: {},
            generalParams: {}
        });
        const embed = new GeminiEmbedCapabilityImpl(mockProvider as any, mockClient as any);
        const req = { input: { input: 'foo' } };
        await embed.embed(req as any);
        expect(mockClient.models.embedContent).toHaveBeenCalledWith(expect.objectContaining({
            model: 'text-embedding-004',
            contents: [{ parts: [{ text: 'foo' }] }],
            config: expect.objectContaining({ taskType: 'RETRIEVAL_QUERY', outputDimensionality: undefined })
        }));
    });
});
