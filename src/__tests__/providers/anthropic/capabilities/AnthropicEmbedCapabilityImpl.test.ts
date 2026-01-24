import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AnthropicEmbedCapabilityImpl } from '#root/providers/anthropic/capabilities/AnthropicEmbedCapabilityImpl.js';

import { CapabilityKeys, AIProvider } from '#root/index.js';
import { BaseProvider } from '#root/core/provider/BaseProvider.js';

class MockProvider extends BaseProvider {
    ensureInitialized = vi.fn();
    getMergedOptions = vi.fn();
    constructor() { super('anthropic' as any); }
}

const OLD_ENV = { ...process.env };


describe('AnthropicEmbedCapabilityImpl', () => {
    let mockProvider: MockProvider;
    beforeEach(() => {
        process.env = { ...OLD_ENV, VOYAGE_API_KEY: 'test-key' };
        mockProvider = new MockProvider();
    });

    it('throws if VOYAGE_API_KEY is missing', () => {
        process.env = { ...OLD_ENV };
        expect(() => new AnthropicEmbedCapabilityImpl(mockProvider)).toThrow('Voyage AI API key is required');
    });

    it('throws if input.input is missing', async () => {
        const impl = new AnthropicEmbedCapabilityImpl(mockProvider);
        await expect(impl.embed({ input: { input: '' }, options: {} }, undefined)).rejects.toThrow('Invalid embedding input');
    });

    it('calls fetch and normalizes output (single string)', async () => {
        const impl = new AnthropicEmbedCapabilityImpl(mockProvider);
        mockProvider.getMergedOptions.mockReturnValue({ model: 'voyage-3', modelParams: {}, providerParams: {} });
        global.fetch = vi.fn().mockResolvedValue({
            ok: true,
            json: async () => ({
                data: [{ embedding: [1, 2, 3], index: 0 }],
                model: 'voyage-3',
                usage: { total_tokens: 5 }
            })
        });
        const req = { input: { input: 'foo' }, options: {}, context: { requestId: 'r1' } };
        const res = await impl.embed(req, undefined);
        expect(res.output).toEqual([1, 2, 3]);
        expect(res.metadata?.provider).toBe(AIProvider.Anthropic);
        expect(res.metadata?.embeddingProvider).toBe('voyage-ai');
    });

    it('calls fetch and normalizes output (array)', async () => {
        const impl = new AnthropicEmbedCapabilityImpl(mockProvider);
        mockProvider.getMergedOptions.mockReturnValue({ model: 'voyage-3', modelParams: {}, providerParams: {} });
        global.fetch = vi.fn().mockResolvedValue({
            ok: true,
            json: async () => ({
                data: [{ embedding: [1, 2, 3], index: 0 }, { embedding: [4, 5, 6], index: 1 }],
                model: 'voyage-3',
                usage: { total_tokens: 10 }
            })
        });
        const req = { input: { input: ['foo', 'bar'] }, options: {}, context: { requestId: 'r1' } };
        const res = await impl.embed(req, undefined);
        expect(res.output).toEqual([[1, 2, 3], [4, 5, 6]]);
        expect(res.metadata?.tokensUsed).toBe(10);
    });

    it('throws on fetch error', async () => {
        const impl = new AnthropicEmbedCapabilityImpl(mockProvider);
        mockProvider.getMergedOptions.mockReturnValue({ model: 'voyage-3', modelParams: {}, providerParams: {} });
        global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 400, text: async () => 'fail' });
        const req = { input: { input: 'foo' }, options: {}, context: { requestId: 'r1' } };
        await expect(impl.embed(req, undefined)).rejects.toThrow('Voyage AI API error: 400 - fail');
    });

    it('uses voyageResponse.model if merged.model is undefined', async () => {
        const impl = new AnthropicEmbedCapabilityImpl(mockProvider);
        mockProvider.getMergedOptions.mockReturnValue({ model: undefined, modelParams: {}, providerParams: {} });
        global.fetch = vi.fn().mockResolvedValue({
            ok: true,
            json: async () => ({
                data: [{ embedding: [1, 2, 3], index: 0 }],
                model: 'voyage-from-api',
                usage: { total_tokens: 5 }
            })
        });
        const req = { input: { input: 'foo' }, options: {}, context: { requestId: 'r1' } };
        const res = await impl.embed(req, undefined);
        expect(res.metadata?.model).toBe('voyage-from-api');
    });
});
