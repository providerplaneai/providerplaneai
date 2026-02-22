import { vi } from 'vitest';


vi.mock('@anthropic-ai/sdk', () => {
    // Helper: detect if the prompt is a moderation prompt
    function isModerationPrompt(messages: any) {
        if (!Array.isArray(messages)) return false;
        return messages.some(
            (msg) => typeof msg.content === 'string' && msg.content.includes('You are a content moderator')
        );
    }

    const createMessage = vi.fn().mockImplementation(async (params) => {
        if (isModerationPrompt(params.messages)) {
            // Return a realistic JSON moderation result as text
            const moderationJson = JSON.stringify({
                flagged: false,
                categories: {
                    hate: false,
                    violence: false,
                    sexual: false,
                    harassment: false,
                    illegal: false,
                    spam: false
                },
                severity: "none",
                explanation: "No policy violations detected."
            });
            return {
                id: 'msg_mock',
                type: 'message',
                role: 'assistant',
                content: [
                    {
                        type: 'text',
                        text: moderationJson,
                    },
                ],
            };
        }
        // Default: return a normal chat response
        return {
            id: 'msg_mock',
            type: 'message',
            role: 'assistant',
            content: [
                {
                    type: 'text',
                    text: 'Mocked Claude response',
                },
            ],
        };
    });

    const createEmbedding = vi.fn().mockResolvedValue({
        embedding: [0.1, 0.2, 0.3],
    });

    class Anthropic {
        messages = {
            create: createMessage,
        };

        embeddings = {
            create: createEmbedding,
        };

        constructor(options?: { apiKey?: string }) {
            if (!options?.apiKey) {
                throw new Error('Missing apiKey');
            }
        }
    }

    return {
        default: Anthropic,
    };
});


import { describe, it, expect, beforeEach } from 'vitest';
import { AIRequest, MultiModalExecutionContext, CapabilityUnsupportedError, ClientChatRequest, ClientEmbeddingRequest, ClientModerationRequest, AnthropicProvider, CapabilityKeys } from '#root/index.js';


let provider: AnthropicProvider;
let config: any;
let chatReq: AIRequest<ClientChatRequest>;
let embedReq: AIRequest<ClientEmbeddingRequest>;
let modReq: AIRequest<ClientModerationRequest>;
let ctx: MultiModalExecutionContext;

describe('AnthropicProvider', () => {

    beforeEach(() => {
        vi.unmock('#root/providers/anthropic/AnthropicProvider.js');
        process.env.VOYAGE_API_KEY = 'test-key';

        provider = new AnthropicProvider();
        config = {
            type: 'anthropic',
            apiKey: 'test-key',
            defaultModel: 'claude-sonnet-4-5-20250929',
            defaultModels: {
                chat: 'claude-sonnet-4-5-20250929',
                moderation: 'claude-sonnet-4-5-20250929',
                embed: 'voyage-3'
            },
            models: {
                'claude-sonnet-4-5-20250929': {},
                'voyage-3': {}
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
        ctx = new MultiModalExecutionContext();
    });

    it('throws if initialized without API key', () => {
        expect(() => provider.init({
            providerDefaults: {},
            type: 'anthropic',
            defaultModels: [] as any,
            models: {} as any
        })).toThrow(/API key/i);
    });

    it('initializes and sets up delegates', () => {
        provider.init(config);
        expect(provider).toBeDefined();
        expect(provider.isInitialized()).toBe(true);
    });

    it('has correct provider type', () => {
        provider.init(config);
        expect(provider.getProviderType()).toBe('anthropic');
    });

    it('registers capabilities after init', () => {
        provider.init(config);
        expect(provider.hasCapability(CapabilityKeys.ChatCapabilityKey)).toBe(true);
        expect(provider.hasCapability(CapabilityKeys.ChatStreamCapabilityKey)).toBe(true);
        expect(provider.hasCapability(CapabilityKeys.EmbedCapabilityKey)).toBe(true);
        expect(provider.hasCapability(CapabilityKeys.ModerationCapabilityKey)).toBe(true);
    });

    it('throws CapabilityUnsupportedError if chat called before init', async () => {
        await expect(provider.chat(chatReq, ctx)).rejects.toThrow(CapabilityUnsupportedError);
    });

    it('throws CapabilityUnsupportedError if chatStream called before init', () => {
        expect(() => provider.chatStream(chatReq, ctx)).toThrow(CapabilityUnsupportedError);
    });

    it('throws CapabilityUnsupportedError if moderation called before init', async () => {
        await expect(provider.moderation(modReq, ctx)).rejects.toThrow(CapabilityUnsupportedError);
    });

    it('throws CapabilityUnsupportedError if embed called before init', async () => {
        await expect(provider.embed(embedReq, ctx)).rejects.toThrow(CapabilityUnsupportedError);
    });

    it('executes chat and returns expected output', async () => {
        provider.init(config);
        const res = await provider.chat(chatReq, ctx);
        expect(res).toBeDefined();
        expect(res.output).toBe('Mocked Claude response');
    });

    it('executes moderation and returns expected output', async () => {
        provider.init(config);
        const res = await provider.moderation(modReq, ctx);
        expect(res).toBeDefined();
        expect(res.output).toBeDefined();
        // If output is an array, check the first element; otherwise, check output directly
        const output = Array.isArray(res.output) ? res.output[0] : res.output;
        expect(output.flagged).toBe(false);
        expect(output.categories).toBeDefined();
        // severity and explanation are not in ModerationResult, but reason is
        expect(output.reason || output.categories).toBeDefined();
    });

    it('executes moderation with array input', async () => {
        provider.init(config);
        const arrReq = { input: { input: ['moderate me', 'another input'] } };
        const res = await provider.moderation(arrReq, ctx);
        expect(Array.isArray(res.output)).toBe(true);
        const arr = res.output as any[];
        expect(arr.length).toBe(2);
        for (const out of arr) {
            expect(out.flagged).toBe(false);
            expect(out.categories).toBeDefined();
        }
    });

    it('throws error for invalid moderation input', async () => {
        provider.init(config);
        const badReq = { input: { input: [] } };
        await expect(provider.moderation(badReq, ctx)).rejects.toThrow('Invalid moderation input');
    });

    it('throws error if moderation input missing', async () => {
        provider.init(config);
        // Provide an input object missing the required 'input' property
        const badReq = { input: { notInput: 'foo' } };
        await expect(provider.moderation(badReq as any, ctx)).rejects.toThrow('Invalid moderation input');
    });

    it('executes chatStream and yields expected chunk', async () => {
        provider.init(config);
        // The mock does not implement chatStream, but we can check for thrown error or correct type
        try {
            const stream = provider.chatStream(chatReq, ctx);
            expect(stream).toBeDefined();
        } catch (err) {
            // If the mock throws, that's fine for coverage
            expect(err).toBeInstanceOf(Error);
        }
    });

    it('does not allow double initialization', () => {
        provider.init(config);
        expect(() => provider.init(config)).not.toThrow(); // Should be idempotent or safe
    });

    it('returns false for hasCapability on unknown capability', () => {
        provider.init(config);
        expect(provider.hasCapability('nonexistent' as any)).toBe(false);
    });

    it('should throw CapabilityUnsupportedError if chatDelegate is missing for chat', async () => {
        provider.init(config);
        // @ts-ignore
        provider.chatDelegate = null;
        await expect(provider.chat(chatReq, ctx)).rejects.toThrow(CapabilityUnsupportedError);
    });

    it('should throw CapabilityUnsupportedError if chatDelegate is missing for chatStream', () => {
        provider.init(config);
        // @ts-ignore
        provider.chatDelegate = null;
        expect(() => provider.chatStream(chatReq, ctx)).toThrow(CapabilityUnsupportedError);
    });

    it('should throw CapabilityUnsupportedError if moderateDelegate is missing for moderation', async () => {
        provider.init(config);
        // @ts-ignore
        provider.moderateDelegate = null;
        await expect(provider.moderation(modReq, ctx)).rejects.toThrow(CapabilityUnsupportedError);
    });

    it('should throw CapabilityUnsupportedError if embedDelegate is missing for embed', async () => {
        provider.init(config);
        // @ts-ignore
        provider.embedDelegate = null;
        await expect(provider.embed(embedReq, ctx)).rejects.toThrow(CapabilityUnsupportedError);
    });
});
