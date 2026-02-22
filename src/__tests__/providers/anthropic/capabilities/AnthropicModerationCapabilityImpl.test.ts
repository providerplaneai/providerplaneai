import { BaseProvider, CapabilityKeys, AIProvider } from '#root/core/index.js';
import { AnthropicModerationCapabilityImpl } from '#root/providers/index.js';
import { describe, it, expect, vi, beforeEach } from 'vitest';

class MockProvider extends BaseProvider {
    ensureInitialized = vi.fn();
    getMergedOptions = vi.fn();
    constructor() { super('anthropic' as any); }
}

const mockClient = { messages: { create: vi.fn() } };

describe('AnthropicModerationCapabilityImpl', () => {
    let impl: AnthropicModerationCapabilityImpl;
    let mockProvider: MockProvider;
    beforeEach(() => {
        mockProvider = new MockProvider();
        mockProvider.ensureInitialized.mockClear();
        mockProvider.getMergedOptions.mockClear();
        mockClient.messages.create.mockClear();
        impl = new AnthropicModerationCapabilityImpl(mockProvider, mockClient as any);
    });

    it('throws if input.input is missing', async () => {
        await expect(impl.moderation({ input: { input: undefined as any }, options: {} }, undefined)).rejects.toThrow('Invalid moderation input');
    });
    it('handles JSON with markdown fences and whitespace', async () => {
        mockProvider.getMergedOptions.mockReturnValue({ model: 'claude', modelParams: {}, providerParams: {} });
        mockClient.messages.create.mockResolvedValue({
            id: 'id',
            content: [{ type: 'text', text: '```json\n{"flagged":false,"categories":{"hate":false,"violence":false,"sexual":false,"harassment":false,"illegal":false,"spam":false},"severity":"none","explanation":"ok"}\n```' }],
            usage: { input_tokens: 1, output_tokens: 1 }
        });
        const req = { input: { input: 'foo' }, options: {}, context: { requestId: 'r1' } };
        const res = await impl.moderation(req, undefined);
        // Type narrowing for single result
        if (!Array.isArray(res.output)) {
            expect(res.output.flagged).toBe(false);
            expect(res.output.categories.hate).toBe(false);
            expect(res.output.reason).toBe('ok');
        } else {
            throw new Error('Expected single ModerationResult');
        }
    });

    it('handles multiple inputs and aggregates tokens', async () => {
        mockProvider.getMergedOptions.mockReturnValue({ model: 'claude', modelParams: {}, providerParams: {} });
        mockClient.messages.create.mockResolvedValueOnce({
            id: 'id1',
            content: [{ type: 'text', text: '{"flagged":false,"categories":{"hate":false,"violence":false,"sexual":false,"harassment":false,"illegal":false,"spam":false},"severity":"none","explanation":"ok1"}' }],
            usage: { input_tokens: 1, output_tokens: 2 }
        }).mockResolvedValueOnce({
            id: 'id2',
            content: [{ type: 'text', text: '{"flagged":true,"categories":{"hate":true,"violence":false,"sexual":false,"harassment":false,"illegal":false,"spam":false},"severity":"high","explanation":"bad"}' }],
            usage: { input_tokens: 2, output_tokens: 3 }
        });
        const req = { input: { input: ['foo', 'bar'] }, options: {}, context: { requestId: 'r1' } };
        const res = await impl.moderation(req, undefined);
        expect(Array.isArray(res.output)).toBe(true);
        if (Array.isArray(res.output)) {
            expect(res.output[0].reason).toBe('ok1');
            expect(res.output[1].reason).toBe('bad');
        } else {
            throw new Error('Expected array of ModerationResult');
        }
        expect(res.metadata && res.metadata.tokensUsed).toBe(8);
    });

    it('handles missing usage in aggregation', async () => {
        mockProvider.getMergedOptions.mockReturnValue({ model: 'claude', modelParams: {}, providerParams: {} });
        mockClient.messages.create.mockResolvedValueOnce({
            id: 'id1',
            content: [{ type: 'text', text: '{"flagged":false,"categories":{"hate":false,"violence":false,"sexual":false,"harassment":false,"illegal":false,"spam":false},"severity":"none","explanation":"ok1"}' }],
            usage: undefined
        }).mockResolvedValueOnce({
            id: 'id2',
            content: [{ type: 'text', text: '{"flagged":true,"categories":{"hate":true,"violence":false,"sexual":false,"harassment":false,"illegal":false,"spam":false},"severity":"high","explanation":"bad"}' }],
            usage: { input_tokens: 2, output_tokens: 3 }
        });
        const req = { input: { input: ['foo', 'bar'] }, options: {}, context: { requestId: 'r1' } };
        const res = await impl.moderation(req, undefined);
        expect(Array.isArray(res.output)).toBe(true);
        expect(res.metadata && res.metadata.tokensUsed).toBe(5);
    });

    it('calls provider.ensureInitialized and getMergedOptions, normalizes output (single)', async () => {
        mockProvider.getMergedOptions.mockReturnValue({ model: 'claude', modelParams: {}, providerParams: {} });
        mockClient.messages.create.mockResolvedValue({
            id: 'id',
            content: [{ type: 'text', text: '{"flagged":true,"categories":{"hate":true,"violence":false,"sexual":false,"harassment":false,"illegal":false,"spam":false},"severity":"high","explanation":"bad"}' }],
            usage: { input_tokens: 2, output_tokens: 3 }
        });
        const req = { input: { input: 'foo' }, options: {}, context: { requestId: 'r1' } };
        const res = await impl.moderation(req, undefined);
        expect(mockProvider.ensureInitialized).toHaveBeenCalled();
        expect(mockProvider.getMergedOptions).toHaveBeenCalledWith(CapabilityKeys.ModerationCapabilityKey, req.options);
        if (!Array.isArray(res.output)) {
            expect(res.output.flagged).toBe(true);
            expect(res.output.categories.hate).toBe(true);
            expect(res.output.reason).toBe('bad');
        } else {
            throw new Error('Expected single ModerationResult');
        }
        expect(res.metadata && res.metadata.tokensUsed).toBe(5);
        expect(res.metadata && res.metadata.provider).toBe(AIProvider.Anthropic);
    });

    it('normalizes output (array)', async () => {
        mockProvider.getMergedOptions.mockReturnValue({ model: 'claude', modelParams: {}, providerParams: {} });
        mockClient.messages.create.mockResolvedValue({
            id: 'id',
            content: [{ type: 'text', text: '{"flagged":false,"categories":{"hate":false,"violence":false,"sexual":false,"harassment":false,"illegal":false,"spam":false},"severity":"none","explanation":"ok"}' }],
            usage: { input_tokens: 1, output_tokens: 1 }
        });
        const req = { input: { input: ['foo', 'bar'] }, options: {}, context: { requestId: 'r1' } };
        const res = await impl.moderation(req, undefined);
        expect(Array.isArray(res.output)).toBe(true);
        if (Array.isArray(res.output)) {
            expect(res.output[0].flagged).toBe(false);
            expect(res.output[1].flagged).toBe(false);
        } else {
            throw new Error('Expected array of ModerationResult');
        }
        expect(res.metadata && res.metadata.tokensUsed).toBe(4);
    });

    it('returns correct output for single input as array', async () => {
        mockProvider.getMergedOptions.mockReturnValue({ model: 'claude', modelParams: {}, providerParams: {} });
        mockClient.messages.create.mockResolvedValue({
            id: 'id',
            content: [{ type: 'text', text: '{"flagged":false,"categories":{"hate":false,"violence":false,"sexual":false,"harassment":false,"illegal":false,"spam":false},"severity":"none","explanation":"ok"}' }],
            usage: { input_tokens: 1, output_tokens: 1 }
        });
        const req = { input: { input: ['foo'] }, options: {}, context: { requestId: 'r1' } };
        const res = await impl.moderation(req, undefined);
        expect(Array.isArray(res.output)).toBe(true);
        if (Array.isArray(res.output)) {
            expect(res.output[0].flagged).toBe(false);
        }
    });

    it('handles empty input array', async () => {
        mockProvider.getMergedOptions.mockReturnValue({ model: 'claude', modelParams: {}, providerParams: {} });
        const req = { input: { input: [] }, options: {}, context: { requestId: 'r1' } };
        await expect(() => impl.moderation(req, undefined)).rejects.toThrow();
    });

    it('throws if no text response from Claude', async () => {
        mockProvider.getMergedOptions.mockReturnValue({ model: 'claude', modelParams: {}, providerParams: {} });
        mockClient.messages.create.mockResolvedValue({ id: 'id', content: [], usage: {} });
        const req = { input: { input: 'foo' }, options: {}, context: { requestId: 'r1' } };
        await expect(() => impl.moderation(req, undefined)).rejects.toThrow('No text response from Claude');
    });

    it('spreads modelParams and providerParams if present', async () => {
        mockProvider.getMergedOptions.mockReturnValue({
            model: 'claude',
            modelParams: { max_tokens: 42, temperature: 0.5 },
            providerParams: { custom: 'foo' }
        });
        mockClient.messages.create.mockResolvedValue({
            id: 'id',
            content: [{ type: 'text', text: '{"flagged":false,"categories":{"hate":false,"violence":false,"sexual":false,"harassment":false,"illegal":false,"spam":false},"severity":"none","explanation":"ok"}' }],
            usage: { input_tokens: 1, output_tokens: 1 }
        });
        const req = { input: { input: 'foo' }, options: {}, context: { requestId: 'r1' } };
        await impl.moderation(req, undefined);
        // Check that create was called with spread params
        expect(mockClient.messages.create).toHaveBeenCalledWith(
            expect.objectContaining({
                model: 'claude',
                max_tokens: 42,
                temperature: 0.5,
                custom: 'foo',
            })
        );
    });

    it('tokensUsed is 0 if all usage missing', async () => {
        mockProvider.getMergedOptions.mockReturnValue({ model: 'claude', modelParams: {}, providerParams: {} });
        mockClient.messages.create.mockResolvedValue({
            id: 'id',
            content: [{ type: 'text', text: '{"flagged":false,"categories":{"hate":false,"violence":false,"sexual":false,"harassment":false,"illegal":false,"spam":false},"severity":"none","explanation":"ok"}' }],
            usage: undefined
        });
        const req = { input: { input: ['foo'] }, options: {}, context: { requestId: 'r1' } };
        const res = await impl.moderation(req, undefined);
        expect(res.metadata && res.metadata.tokensUsed).toBe(0);
    });

    it('tokensUsed sums only present usage', async () => {
        mockProvider.getMergedOptions.mockReturnValue({ model: 'claude', modelParams: {}, providerParams: {} });
        mockClient.messages.create.mockResolvedValueOnce({
            id: 'id1',
            content: [{ type: 'text', text: '{"flagged":false,"categories":{"hate":false,"violence":false,"sexual":false,"harassment":false,"illegal":false,"spam":false},"severity":"none","explanation":"ok1"}' }],
            usage: undefined
        }).mockResolvedValueOnce({
            id: 'id2',
            content: [{ type: 'text', text: '{"flagged":true,"categories":{"hate":true,"violence":false,"sexual":false,"harassment":false,"illegal":false,"spam":false},"severity":"high","explanation":"bad"}' }],
            usage: { input_tokens: 2, output_tokens: 3 }
        });
        const req = { input: { input: ['foo', 'bar'] }, options: {}, context: { requestId: 'r1' } };
        const res = await impl.moderation(req, undefined);
        expect(res.metadata && res.metadata.tokensUsed).toBe(5);
    });

    it('uses default model if merged.model is undefined', async () => {
        mockProvider.getMergedOptions.mockReturnValue({ model: undefined, modelParams: {}, providerParams: {} });
        mockClient.messages.create.mockResolvedValue({
            id: 'id',
            content: [{ type: 'text', text: '{"flagged":false,"categories":{"hate":false,"violence":false,"sexual":false,"harassment":false,"illegal":false,"spam":false},"severity":"none","explanation":"ok"}' }],
            usage: { input_tokens: 1, output_tokens: 1 }
        });
        const req = { input: { input: 'foo' }, options: {}, context: { requestId: 'r1' } };
        await impl.moderation(req, undefined);
        expect(mockClient.messages.create).toHaveBeenCalledWith(
            expect.objectContaining({ model: 'claude-sonnet-4-20250514' })
        );
    });

    it('spreads undefined modelParams and providerParams safely', async () => {
        mockProvider.getMergedOptions.mockReturnValue({ model: 'claude' });
        mockClient.messages.create.mockResolvedValue({
            id: 'id',
            content: [{ type: 'text', text: '{"flagged":false,"categories":{"hate":false,"violence":false,"sexual":false,"harassment":false,"illegal":false,"spam":false},"severity":"none","explanation":"ok"}' }],
            usage: { input_tokens: 1, output_tokens: 1 }
        });
        const req = { input: { input: 'foo' }, options: {}, context: { requestId: 'r1' } };
        await impl.moderation(req, undefined);
        // Should not throw, and should call with only model/max_tokens/messages
        expect(mockClient.messages.create).toHaveBeenCalledWith(
            expect.objectContaining({ model: 'claude', max_tokens: 1024 })
        );
    });

    it('tokensUsed sums partial usage (only input_tokens)', async () => {
        mockProvider.getMergedOptions.mockReturnValue({ model: 'claude', modelParams: {}, providerParams: {} });
        mockClient.messages.create.mockResolvedValue({
            id: 'id',
            content: [{ type: 'text', text: '{"flagged":false,"categories":{"hate":false,"violence":false,"sexual":false,"harassment":false,"illegal":false,"spam":false},"severity":"none","explanation":"ok"}' }],
            usage: { input_tokens: 7 }
        });
        const req = { input: { input: ['foo'] }, options: {}, context: { requestId: 'r1' } };
        const res = await impl.moderation(req, undefined);
        expect(res.metadata && res.metadata.tokensUsed).toBe(7);
    });

    it('tokensUsed sums partial usage (only output_tokens)', async () => {
        mockProvider.getMergedOptions.mockReturnValue({ model: 'claude', modelParams: {}, providerParams: {} });
        mockClient.messages.create.mockResolvedValue({
            id: 'id',
            content: [{ type: 'text', text: '{"flagged":false,"categories":{"hate":false,"violence":false,"sexual":false,"harassment":false,"illegal":false,"spam":false},"severity":"none","explanation":"ok"}' }],
            usage: { output_tokens: 5 }
        });
        const req = { input: { input: ['foo'] }, options: {}, context: { requestId: 'r1' } };
        const res = await impl.moderation(req, undefined);
        expect(res.metadata && res.metadata.tokensUsed).toBe(5);
    });
});
