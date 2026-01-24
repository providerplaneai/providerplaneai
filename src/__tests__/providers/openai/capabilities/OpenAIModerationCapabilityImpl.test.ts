import { BaseProvider, CapabilityKeys, AIProvider } from '#root/core/index.js';
import { OpenAIModerationCapabilityImpl } from '#root/providers/index.js';
import { describe, it, expect, vi, beforeEach } from 'vitest';

class MockProvider extends BaseProvider {
    ensureInitialized = vi.fn();
    getMergedOptions = vi.fn();
    constructor() { super('openai' as any); }
}

const mockClient = { moderations: { create: vi.fn() } };

describe('OpenAIModerationCapabilityImpl', () => {
    let impl: OpenAIModerationCapabilityImpl;
    let mockProvider: MockProvider;
    beforeEach(() => {
        mockProvider = new MockProvider();
        mockProvider.ensureInitialized.mockClear();
        mockProvider.getMergedOptions.mockClear();
        mockClient.moderations.create.mockClear();
        impl = new OpenAIModerationCapabilityImpl(mockProvider, mockClient as any);
    });

    it('throws if input.input is missing', async () => {
        await expect(impl.moderation({ input: { input: undefined as any }, options: {} }, undefined)).rejects.toThrow('Invalid moderation input');
    });

    it('calls provider.ensureInitialized and getMergedOptions, normalizes output (single)', async () => {
        mockProvider.getMergedOptions.mockReturnValue({ model: 'omni-moderation-latest', modelParams: {}, providerParams: {} });
        mockClient.moderations.create.mockResolvedValue({
            id: 'id',
            results: [
                {
                    flagged: true,
                    categories: { hate: true, violence: false },
                    category_scores: { hate: 0.9, violence: 0.1 },
                }
            ],
            usage: { total_tokens: 5 }
        });
        const req = { input: { input: 'foo' }, options: {}, context: { requestId: 'r1' } };
        const res = await impl.moderation(req, undefined);
        expect(mockProvider.ensureInitialized).toHaveBeenCalled();
        expect(mockProvider.getMergedOptions).toHaveBeenCalledWith(CapabilityKeys.ModerationCapabilityKey, req.options);
        if (!Array.isArray(res.output)) {
            expect(res.output.flagged).toBe(true);
            expect(res.output.categories?.hate).toBe(true);
            expect((res.output.categoryScores ?? {}).hate).toBe(0.9);
            expect(res.output.reason).toBe('hate');
        } else {
            throw new Error('Expected single ModerationResult');
        }
        expect(res.metadata && res.metadata.tokensUsed).toBe(5);
        expect(res.metadata && res.metadata.provider).toBe(AIProvider.OpenAI);
    });

    it('normalizes output (array)', async () => {
        mockProvider.getMergedOptions.mockReturnValue({ model: 'omni-moderation-latest', modelParams: {}, providerParams: {} });
        mockClient.moderations.create.mockResolvedValue({
            id: 'id',
            results: [
                { flagged: false, categories: { hate: false }, category_scores: { hate: 0.1 } },
                { flagged: true, categories: { hate: true }, category_scores: { hate: 0.8 } }
            ],
            usage: { total_tokens: 7 }
        });
        const req = { input: { input: ['foo', 'bar'] }, options: {}, context: { requestId: 'r1' } };
        const res = await impl.moderation(req, undefined);
        expect(Array.isArray(res.output)).toBe(true);
        if (Array.isArray(res.output)) {
            expect(res.output[0].flagged).toBe(false);
            expect(res.output[1].flagged).toBe(true);
        } else {
            throw new Error('Expected array of ModerationResult');
        }
        expect(res.metadata && res.metadata.tokensUsed).toBe(7);
    });

    it('spreads modelParams and providerParams if present', async () => {
        mockProvider.getMergedOptions.mockReturnValue({
            model: 'omni-moderation-latest',
            modelParams: { custom: 42 },
            providerParams: { foo: 'bar' }
        });
        mockClient.moderations.create.mockResolvedValue({
            id: 'id',
            results: [
                { flagged: false, categories: { hate: false }, category_scores: { hate: 0.1 } }
            ],
            usage: { total_tokens: 2 }
        });
        const req = { input: { input: 'foo' }, options: {}, context: { requestId: 'r1' } };
        await impl.moderation(req, undefined);
        expect(mockClient.moderations.create).toHaveBeenCalledWith(
            expect.objectContaining({
                model: 'omni-moderation-latest',
                custom: 42,
                foo: 'bar',
                input: 'foo'
            })
        );
    });

    it('uses default model if merged.model is undefined', async () => {
        mockProvider.getMergedOptions.mockReturnValue({ model: undefined, modelParams: {}, providerParams: {} });
        mockClient.moderations.create.mockResolvedValue({
            id: 'id',
            results: [
                { flagged: false, categories: { hate: false }, category_scores: { hate: 0.1 } }
            ],
            usage: { total_tokens: 1 }
        });
        const req = { input: { input: 'foo' }, options: {}, context: { requestId: 'r1' } };
        await impl.moderation(req, undefined);
        expect(mockClient.moderations.create).toHaveBeenCalledWith(
            expect.objectContaining({ model: 'omni-moderation-latest' })
        );
    });

    it('spreads undefined modelParams and providerParams safely', async () => {
        mockProvider.getMergedOptions.mockReturnValue({ model: 'omni-moderation-latest' });
        mockClient.moderations.create.mockResolvedValue({
            id: 'id',
            results: [
                { flagged: false, categories: { hate: false }, category_scores: { hate: 0.1 } }
            ],
            usage: { total_tokens: 1 }
        });
        const req = { input: { input: 'foo' }, options: {}, context: { requestId: 'r1' } };
        await impl.moderation(req, undefined);
        expect(mockClient.moderations.create).toHaveBeenCalledWith(
            expect.objectContaining({ model: 'omni-moderation-latest' })
        );
    });

    it('normalizes output for single input as array', async () => {
        mockProvider.getMergedOptions.mockReturnValue({ model: 'omni-moderation-latest', modelParams: {}, providerParams: {} });
        mockClient.moderations.create.mockResolvedValue({
            id: 'id',
            results: [
                { flagged: false, categories: { hate: false }, category_scores: { hate: 0.1 } }
            ],
            usage: { total_tokens: 1 }
        });
        const req = { input: { input: ['foo'] }, options: {}, context: { requestId: 'r1' } };
        const res = await impl.moderation(req, undefined);
        expect(Array.isArray(res.output)).toBe(true);
        if (Array.isArray(res.output)) {
            expect(res.output[0].flagged).toBe(false);
        }
    });

    it('handles missing usage in response', async () => {
        mockProvider.getMergedOptions.mockReturnValue({ model: 'omni-moderation-latest', modelParams: {}, providerParams: {} });
        mockClient.moderations.create.mockResolvedValue({
            id: 'id',
            results: [
                { flagged: false, categories: { hate: false }, category_scores: { hate: 0.1 } }
            ]
        });
        const req = { input: { input: 'foo' }, options: {}, context: { requestId: 'r1' } };
        const res = await impl.moderation(req, undefined);
        expect(res.metadata && res.metadata.tokensUsed).toBeUndefined();
    });

    it('handles nullish categories and category_scores', async () => {
        mockProvider.getMergedOptions.mockReturnValue({ model: 'omni-moderation-latest', modelParams: {}, providerParams: {} });
        mockClient.moderations.create.mockResolvedValue({
            id: 'id',
            results: [
                { flagged: false, categories: undefined, category_scores: undefined }
            ],
            usage: { total_tokens: 1 }
        });
        const req = { input: { input: 'foo' }, options: {}, context: { requestId: 'r1' } };
        const res = await impl.moderation(req, undefined);
        if (!Array.isArray(res.output)) {
            expect(res.output.categories).toEqual({});
            expect(res.output.categoryScores).toEqual({});
            expect(res.output.reason).toBe('');
        }
    });

    it('handles empty categories and category_scores', async () => {
        mockProvider.getMergedOptions.mockReturnValue({ model: 'omni-moderation-latest', modelParams: {}, providerParams: {} });
        mockClient.moderations.create.mockResolvedValue({
            id: 'id',
            results: [
                { flagged: false, categories: {}, category_scores: {} }
            ],
            usage: { total_tokens: 1 }
        });
        const req = { input: { input: 'foo' }, options: {}, context: { requestId: 'r1' } };
        const res = await impl.moderation(req, undefined);
        if (!Array.isArray(res.output)) {
            expect(res.output.categories).toEqual({});
            expect(res.output.categoryScores).toEqual({});
            expect(res.output.reason).toBe('');
        }
    });
});
