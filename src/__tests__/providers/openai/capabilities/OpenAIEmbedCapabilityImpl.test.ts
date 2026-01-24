import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OpenAIEmbedCapabilityImpl } from '#root/providers/openai/capabilities/OpenAIEmbedCapabilityImpl.js';
import { AIProvider, CapabilityKeys } from '#root/index.js';

const mockProvider = {
    ensureInitialized: vi.fn(),
    getMergedOptions: vi.fn((cap, opts) => ({ model: 'mock-model', modelParams: {}, providerParams: {}, generalParams: {} }))
};
const mockClient = {
    embeddings: {
        create: vi.fn()
    }
};

describe('OpenAIEmbedCapabilityImpl', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('throws if input is missing', async () => {
        const embed = new OpenAIEmbedCapabilityImpl(mockProvider as any, mockClient as any);
        await expect(embed.embed({ input: undefined } as any)).rejects.toThrow('Invalid embedding input');
    });

        it('throws if API returns no data', async () => {
            mockClient.embeddings.create.mockResolvedValue({ data: [] });
            const embed = new OpenAIEmbedCapabilityImpl(mockProvider as any, mockClient as any);
            // OpenAI implementation does not throw, but returns output as undefined if no data
            const res = await embed.embed({ input: { input: 'foo' } } as any);
            expect(res.output).toBeUndefined();
        });

        it('returns output as undefined if embedding is missing in response', async () => {
            mockClient.embeddings.create.mockResolvedValue({ data: [{ notEmbedding: [1, 2, 3] }] });
            const embed = new OpenAIEmbedCapabilityImpl(mockProvider as any, mockClient as any);
            const res = await embed.embed({ input: { input: 'foo' } } as any);
            expect(res.output).toBeUndefined();
        });

    it('returns normalized embedding response for single input', async () => {
        mockClient.embeddings.create.mockResolvedValue({ data: [{ embedding: [1, 2, 3] }], usage: { total_tokens: 10 } });
        const embed = new OpenAIEmbedCapabilityImpl(mockProvider as any, mockClient as any);
        const res = await embed.embed({ input: { input: 'foo' } } as any);
        expect(res.output).toEqual([1, 2, 3]);
        expect(res.metadata?.provider).toBe(AIProvider.OpenAI);
        expect(res.metadata?.tokensUsed).toBe(10);
    });

    it('returns normalized embedding response for multiple inputs', async () => {
        mockClient.embeddings.create.mockResolvedValue({ data: [{ embedding: [1, 2, 3] }, { embedding: [4, 5, 6] }], usage: { total_tokens: 20 } });
        const embed = new OpenAIEmbedCapabilityImpl(mockProvider as any, mockClient as any);
        const res = await embed.embed({ input: { input: ['foo', 'bar'] } } as any);
        expect(res.output).toEqual([[1, 2, 3], [4, 5, 6]]);
        expect(res.metadata?.provider).toBe(AIProvider.OpenAI);
        expect(res.metadata?.tokensUsed).toBe(20);
    });

    it('passes correct model and options to embeddings.create (custom options)', async () => {
        mockClient.embeddings.create.mockResolvedValue({ data: [{ embedding: [1] }] });
        mockProvider.getMergedOptions.mockReturnValueOnce({
            model: 'custom',
            modelParams: { customParam: 123 },
            providerParams: { foo: 'bar' },
            generalParams: {}
        });
        const embed = new OpenAIEmbedCapabilityImpl(mockProvider as any, mockClient as any);
        const req = { input: { input: 'foo' }, options: { model: 'custom', modelParams: { customParam: 123 }, providerParams: { foo: 'bar' } } };
        await embed.embed(req as any);
        expect(mockClient.embeddings.create).toHaveBeenCalledWith(expect.objectContaining({
            model: 'custom',
            input: 'foo',
            customParam: 123,
            foo: 'bar'
        }));
    });

    it('uses default model if not provided', async () => {
        mockClient.embeddings.create.mockResolvedValue({ data: [{ embedding: [1] }] });
        mockProvider.getMergedOptions.mockReturnValueOnce({
            model: "text-embedding-3-large",
            modelParams: {},
            providerParams: {},
            generalParams: {}
        });
        const embed = new OpenAIEmbedCapabilityImpl(mockProvider as any, mockClient as any);
        const req = { input: { input: 'foo' } };
        await embed.embed(req as any);
        expect(mockClient.embeddings.create).toHaveBeenCalledWith(expect.objectContaining({
            model: 'text-embedding-3-large',
            input: 'foo'
        }));
    });
});
