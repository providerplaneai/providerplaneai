import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GeminiModerationCapabilityImpl } from '#root/providers/gemini/capabilities/GeminiModerationCapabilityImpl.js';
import { AIProvider } from '#root/index.js';

const mockProvider = {
    ensureInitialized: vi.fn(),
    getMergedOptions: vi.fn(() => ({ model: 'mock-model', modelParams: {}, providerParams: {}, generalParams: {} }))
};

const mockClient = {
    models: {
        generateContent: vi.fn()
    }
};

describe('GeminiModerationCapabilityImpl', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('moderates a single input string', async () => {
        const gem = new GeminiModerationCapabilityImpl(mockProvider as any, mockClient as any);
        const mockResponse = { text: JSON.stringify({ flagged: true, categories: { sexual: false, hate: true, harassment: false, self_harm: false, violence: true }, reasoning: 'test reason' }) };
        mockClient.models.generateContent.mockResolvedValue(mockResponse);
        const req = { input: { input: 'bad content' } };
        const res = await gem.moderation(req as any);
        if (Array.isArray(res.output)) throw new Error('Expected single ModerationResult');
        expect(res.output.flagged).toBe(true);
        expect(res.output.categories.hate).toBe(true);
        expect(res.output.reason).toBe('test reason');
        expect(res.metadata?.provider).toBe(AIProvider.Gemini);
    });

    it('moderates multiple input strings', async () => {
        const gem = new GeminiModerationCapabilityImpl(mockProvider as any, mockClient as any);
        const mockResponse1 = { text: JSON.stringify({ flagged: false, categories: { sexual: false, hate: false, harassment: false, self_harm: false, violence: false }, reasoning: 'ok' }) };
        const mockResponse2 = { text: JSON.stringify({ flagged: true, categories: { sexual: true, hate: false, harassment: true, self_harm: false, violence: false }, reasoning: 'bad' }) };
        mockClient.models.generateContent.mockResolvedValueOnce(mockResponse1).mockResolvedValueOnce(mockResponse2);
        const req = { input: { input: ['good', 'bad'] } };
        const res = await gem.moderation(req as any);
        expect(Array.isArray(res.output)).toBe(true);
        if (!Array.isArray(res.output)) throw new Error('Expected ModerationResult[]');
        expect(res.output[0].flagged).toBe(false);
        expect(res.output[1].flagged).toBe(true);
        expect(res.output[1].categories.sexual).toBe(true);
    });

    it('throws on invalid input', async () => {
        const gem = new GeminiModerationCapabilityImpl(mockProvider as any, mockClient as any);
        await expect(gem.moderation({ input: {} } as any)).rejects.toThrow('Invalid moderation input');
    });

    it('passes correct model and config to generateContent', async () => {
        const gem = new GeminiModerationCapabilityImpl(mockProvider as any, mockClient as any);
        mockClient.models.generateContent.mockResolvedValue({ text: JSON.stringify({ flagged: false, categories: {}, reasoning: '' }) });
        const req = { input: { input: 'test' }, options: { model: 'custom-model', modelParams: { temperature: 0.1 }, providerParams: { foo: 'bar' } } };
        await gem.moderation(req as any);
        expect(mockClient.models.generateContent).toHaveBeenCalledWith(expect.objectContaining({
            model: 'mock-model',
            config: expect.objectContaining({ responseMimeType: 'application/json', responseSchema: expect.any(Object), temperature: 0 }),
        }));
    });
});
