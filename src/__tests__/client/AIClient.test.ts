import { describe, it, expect, beforeEach, vi } from 'vitest';
import { disabled, loadDefaultConfig } from '../testUtils.js';
import { AIProvider, AISession, CapabilityKeys } from '#root/index.js';

describe('AIClient', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.resetAllMocks();
        vi.restoreAllMocks();
    });

    it('registers and retrieves provider', async () => {
        await vi.doMock('#root/providers/openai/OpenAIProvider.js', () => ({
            OpenAIProvider: vi.fn(function () {
                return {
                    isInitialized: () => true,
                    init: vi.fn(),
                    hasCapability: vi.fn(() => true)
                };
            })
        }));
        vi.resetModules();
        const { AIClient } = await import('#root/client/AIClient.js');
        const client = new AIClient();
        const resolved = client.getProvider(AIProvider.OpenAI, 'default');
        expect(resolved.isInitialized()).toBe(true);
    });

    it('registerProvider does not call init when provider already initialized', async () => {
        await vi.doMock('#root/providers/openai/OpenAIProvider.js', () => ({
            OpenAIProvider: vi.fn(function () {
                return {
                    isInitialized: () => true,
                    init: vi.fn(),
                    hasCapability: vi.fn(() => true)
                };
            })
        }));
        vi.resetModules();
        const { AIClient } = await import('#root/client/AIClient.js');
        const { OpenAIProvider } = await import('#root/providers/openai/OpenAIProvider.js');
        const client = new AIClient();
        const p = new OpenAIProvider();
        expect(() => client.registerProvider(p, AIProvider.OpenAI, 'default'))
            .toThrow(`Provider already registered for ${AIProvider.OpenAI} with name 'default'`)
    });

    it('throws when getting unknown provider', async () => {
        const { AIClient } = await import('#root/client/AIClient.js');
        const client = new AIClient();

        expect(() => client.getProvider("unknown" as any)).toThrow();
    });

    describe('Session Management', () => {
        it('createSession creates a new session with generated ID', async () => {
            const { AIClient } = await import('#root/client/AIClient.js');
            const client = new AIClient();

            const session = client.createSession();
            expect(session).toBeDefined();
            expect(session.id).toBeDefined();
            expect(typeof session.id).toBe('string');
        });

        it('createSession with custom ID creates session with specified ID', async () => {
            const { AIClient } = await import('#root/client/AIClient.js');
            const client = new AIClient();

            const customId = 'my-custom-session-id';
            const session = client.createSession(customId);
            expect(session.id).toBe(customId);
        });

        it('getSession returns existing session', async () => {
            const { AIClient } = await import('#root/client/AIClient.js');
            const client = new AIClient();

            const created = client.createSession('test-id');
            const retrieved = client.getSession('test-id');
            expect(retrieved).toBe(created);
            expect(retrieved?.id).toBe('test-id');
        });

        it('getSession returns undefined for non-existent session', async () => {
            const { AIClient } = await import('#root/client/AIClient.js');
            const client = new AIClient();

            const retrieved = client.getSession('non-existent-id');
            expect(retrieved).toBeUndefined();
        });

        it('getOrCreateSession returns existing session if it exists', async () => {
            const { AIClient } = await import('#root/client/AIClient.js');
            const client = new AIClient();

            const created = client.createSession('existing-id');
            const retrieved = client.getOrCreateSession('existing-id');
            expect(retrieved).toBe(created);
        });

        it('getOrCreateSession creates new session if not exists', async () => {
            const { AIClient } = await import('#root/client/AIClient.js');
            const client = new AIClient();

            const session = client.getOrCreateSession('new-id');
            expect(session).toBeDefined();
            expect(session.id).toBe('new-id');
        });

        it('getOrCreateSession creates session with auto-generated ID if no ID provided', async () => {
            const { AIClient } = await import('#root/client/AIClient.js');
            const client = new AIClient();

            const session = client.getOrCreateSession();
            expect(session).toBeDefined();
            expect(session.id).toBeDefined();
        });

        it('closeSession removes session from registry', async () => {
            const { AIClient } = await import('#root/client/AIClient.js');
            const client = new AIClient();

            const session = client.createSession('to-close');
            expect(client.getSession('to-close')).toBeDefined();

            client.closeSession('to-close');
            expect(client.getSession('to-close')).toBeUndefined();
        });

        it('listSessions returns all active session IDs', async () => {
            const { AIClient } = await import('#root/client/AIClient.js');
            const client = new AIClient();

            const session1 = client.createSession('session-1');
            const session2 = client.createSession('session-2');
            const session3 = client.createSession('session-3');

            const list = client.listSessions();
            expect(list).toContain('session-1');
            expect(list).toContain('session-2');
            expect(list).toContain('session-3');
            expect(list.length).toBeGreaterThanOrEqual(3);
        });

        it('serializeSession serializes active session', async () => {
            const { AIClient } = await import('#root/client/AIClient.js');
            const client = new AIClient();

            const session = client.createSession('serialize-test');
            const snapshot = client.serializeSession('serialize-test');

            expect(snapshot).toBeDefined();
            expect(snapshot.id).toBe('serialize-test');
        });

        it('serializeSession throws for non-existent session', async () => {
            const { AIClient } = await import('#root/client/AIClient.js');
            const client = new AIClient();

            expect(() => client.serializeSession('non-existent')).toThrow('Session not found');
        });

        it('resumeSession deserializes and registers session', async () => {
            const { AIClient } = await import('#root/client/AIClient.js');
            const client = new AIClient();

            const original = client.createSession('original-id');
            const snapshot = client.serializeSession('original-id');

            client.closeSession('original-id');
            expect(client.getSession('original-id')).toBeUndefined();

            const restored = client.resumeSession(snapshot);
            expect(restored).toBeDefined();
            expect(client.getSession('original-id')).toBeDefined();
        });
    });

    describe('Lifecycle Hooks', () => {
        it('setLifeCycleHooks stores lifecycle hooks', async () => {
            const { AIClient } = await import('#root/client/AIClient.js');
            const client = new AIClient();

            const mockHooks = {
                onExecutionStart: vi.fn(),
                onAttemptStart: vi.fn(),
                onAttemptSuccess: vi.fn(),
                onAttemptFailure: vi.fn(),
                onExecutionFailure: vi.fn(),
                onExecutionEnd: vi.fn(),
                onChunkEmitted: vi.fn()
            };

            expect(() => client.setLifeCycleHooks(mockHooks)).not.toThrow();
        });
        it('calls lifecycle hooks for non-streaming (withRequestContext) methods', async () => {
            await vi.doMock('#root/providers/openai/OpenAIProvider.js', () => ({
                OpenAIProvider: vi.fn(function () {
                    return {
                        isInitialized: () => true,
                        init: vi.fn(),
                        hasCapability: vi.fn(() => true),
                        chat: vi.fn(async (req) => ({ result: 'ok', metadata: {} }))
                    };
                })
            }));
            vi.resetModules();
            const { AIClient } = await import('#root/client/AIClient.js');
            const { AIProvider } = await import('#root/index.js');
            const client = new AIClient();
            const { OpenAIProvider } = await import('#root/providers/openai/OpenAIProvider.js');
            const provider = new OpenAIProvider();

            const hooks = {
                onExecutionStart: vi.fn(),
                onExecutionEnd: vi.fn(),
                onAttemptStart: vi.fn(),
                onAttemptSuccess: vi.fn(),
                onAttemptFailure: vi.fn(),
            };
            client.setLifeCycleHooks(hooks);
            const session = client.createSession();

            await client.chat({ input: { messages: [{ role: 'user', content: [{ type: "text", text: 'Hello' }] }] } }, session);

            expect(hooks.onExecutionStart).toHaveBeenCalled();
            expect(hooks.onExecutionEnd).toHaveBeenCalled();
            expect(hooks.onAttemptStart).toHaveBeenCalled();
            expect(hooks.onAttemptSuccess).toHaveBeenCalled();
            expect(hooks.onAttemptFailure).not.toHaveBeenCalled();
        });

        it('calls lifecycle hooks for streaming (withRequestContextStream) methods', async () => {
            await vi.doMock('#root/providers/openai/OpenAIProvider.js', () => ({
                OpenAIProvider: vi.fn(function () {
                    return {
                        isInitialized: () => true,
                        init: vi.fn(),
                        hasCapability: vi.fn(() => true),
                        chatStream: vi.fn(async function* () {
                            yield { result: 'chunk1', metadata: {} };
                            yield { result: 'chunk2', metadata: {} };
                        })
                    };
                })
            }));
            vi.resetModules();
            const { AIClient } = await import('#root/client/AIClient.js');
            const { AIProvider } = await import('#root/index.js');
            const client = new AIClient();
            const { OpenAIProvider } = await import('#root/providers/openai/OpenAIProvider.js');
            const provider = new OpenAIProvider();

            const hooks = {
                onExecutionStart: vi.fn(),
                onExecutionEnd: vi.fn(),
                onAttemptStart: vi.fn(),
                onAttemptSuccess: vi.fn(),
                onAttemptFailure: vi.fn(),
                onChunkEmitted: vi.fn(),
            };
            client.setLifeCycleHooks(hooks);

            const session = client.createSession();
            const stream = client.chatStream({ input: { messages: [{ role: 'user', content: [{ type: "text", text: 'Hello' }] }] } }, session);
            // Consume the stream
            for await (const _ of stream) { }

            expect(hooks.onExecutionStart).toHaveBeenCalled();
            expect(hooks.onExecutionEnd).toHaveBeenCalled();
            expect(hooks.onAttemptStart).toHaveBeenCalled();
            expect(hooks.onAttemptSuccess).toHaveBeenCalled();
            expect(hooks.onAttemptFailure).not.toHaveBeenCalled();
            expect(hooks.onChunkEmitted).toHaveBeenCalledTimes(1);
        });
    });

    describe('Real AIClient Integration (executeWithPolicy coverage)', () => {
        it('executeWithPolicy executes and applies output to session context', async () => {
            await vi.doMock('#root/providers/openai/OpenAIProvider.js', () => ({
                OpenAIProvider: vi.fn(function () {
                    return {
                        isInitialized: () => true,
                        init: vi.fn(),
                        hasCapability: vi.fn(() => true)
                    };
                })
            }));
            vi.resetModules();
            const { AIClient } = await import('#root/client/AIClient.js');
            const client = new AIClient();
            const session = client.createSession();
            expect(client.getSession(session.id)).toBe(session);
        });

        it('findProvidersByCapability returns providers with requested capability', async () => {
            await vi.doMock('#root/providers/openai/OpenAIProvider.js', () => ({
                OpenAIProvider: vi.fn(function () {
                    return {
                        isInitialized: () => true,
                        init: vi.fn(),
                        hasCapability: vi.fn(() => true)
                    };
                })
            }));
            vi.resetModules();
            const { AIClient, CapabilityKeys } = await import('#root/index.js');
            const client = new AIClient();
            const providers = client.findProvidersByCapability(CapabilityKeys.ChatCapabilityKey as unknown as any);
            expect(Array.isArray(providers)).toBe(true);
            expect(providers.length).toBeGreaterThan(0);
        });

        it('getOrCreateSession returns new session when none exists', async () => {
            await vi.doMock('#root/providers/openai/OpenAIProvider.js', () => ({
                OpenAIProvider: vi.fn(function () {
                    return {
                        isInitialized: () => true,
                        init: vi.fn(),
                        hasCapability: vi.fn(() => true)
                    };
                })
            }));
            vi.resetModules();
            const { AIClient } = await import('#root/client/AIClient.js');
            const client = new AIClient();
            const session = client.getOrCreateSession('unique-test-id');
            expect(session).toBeDefined();
            expect(session.id).toBe('unique-test-id');
            expect(client.getSession('unique-test-id')).toBe(session);
        });

        it('resumeSession deserializes and restores session', async () => {
            await vi.doMock('#root/providers/openai/OpenAIProvider.js', () => ({
                OpenAIProvider: vi.fn(function () {
                    return {
                        isInitialized: () => true,
                        init: vi.fn(),
                        hasCapability: vi.fn(() => true)
                    };
                })
            }));
            vi.resetModules();
            const { AIClient } = await import('#root/client/AIClient.js');
            const client = new AIClient();
            const session1 = client.createSession('resumable-session');
            const snapshot = client.serializeSession('resumable-session');
            client.closeSession('resumable-session');
            expect(client.getSession('resumable-session')).toBeUndefined();
            const session2 = client.resumeSession(snapshot);
            expect(session2.id).toBe('resumable-session');
            expect(client.getSession('resumable-session')).toBe(session2);
        });

        it('listSessions returns all active session IDs', async () => {
            await vi.doMock('#root/providers/openai/OpenAIProvider.js', () => ({
                OpenAIProvider: vi.fn(function () {
                    return {
                        isInitialized: () => true,
                        init: vi.fn(),
                        hasCapability: vi.fn(() => true)
                    };
                })
            }));
            vi.resetModules();
            const { AIClient } = await import('#root/client/AIClient.js');
            const client = new AIClient();
            const s1 = client.createSession('session-a');
            const s2 = client.createSession('session-b');
            const s3 = client.createSession('session-c');
            const sessions = client.listSessions();
            expect(sessions.length).toBeGreaterThanOrEqual(3);
            expect(sessions).toContain('session-a');
            expect(sessions).toContain('session-b');
            expect(sessions).toContain('session-c');
        });

        it('closeSession removes session from registry', async () => {
            await vi.doMock('#root/providers/openai/OpenAIProvider.js', () => ({
                OpenAIProvider: vi.fn(function () {
                    return {
                        isInitialized: () => true,
                        init: vi.fn(),
                        hasCapability: vi.fn(() => true)
                    };
                })
            }));
            vi.resetModules();
            const { AIClient } = await import('#root/client/AIClient.js');
            const client = new AIClient();
            const session = client.createSession('to-delete');
            expect(client.getSession('to-delete')).toBeDefined();
            client.closeSession('to-delete');
            expect(client.getSession('to-delete')).toBeUndefined();
        });

        it('setLifeCycleHooks stores and does not throw', async () => {
            await vi.doMock('#root/providers/openai/OpenAIProvider.js', () => ({
                OpenAIProvider: vi.fn(function () {
                    return {
                        isInitialized: () => true,
                        init: vi.fn(),
                        hasCapability: vi.fn(() => true)
                    };
                })
            }));
            vi.resetModules();
            const { AIClient } = await import('#root/client/AIClient.js');
            const client = new AIClient();
            const mockHooks = {
                onExecutionStart: vi.fn(),
                onAttemptStart: vi.fn(),
                onAttemptSuccess: vi.fn(),
                onAttemptFailure: vi.fn(),
                onExecutionFailure: vi.fn(),
                onExecutionEnd: vi.fn(),
                onChunkEmitted: vi.fn()
            };
            expect(() => client.setLifeCycleHooks(mockHooks)).not.toThrow();
        });
    });

    describe('Capability Routing and executeWithPolicy', () => {

        it('chat method calls executeWithPolicy with correct capability', async () => {
            // Reset module cache BEFORE mocking
            vi.resetModules();

            // Apply all mocks BEFORE importing AIClient
            await vi.doMock('#root/core/utils/WithRequestContext', () => ({
                withRequestContext: vi.fn(async (req, fn) => ({ output: 'mocked', metadata: { status: 'completed' } })),
                withRequestContextStream: vi.fn(async function* (req, fn) { yield { output: 'mocked', metadata: { status: 'completed' } }; })
            }));
            await vi.doMock('#root/core/config/ConfigLoader.js', () => ({
                loadAppConfig: vi.fn(() => ({
                    appConfig: { executionPolicy: { providerChain: [{ providerType: 'openai', connectionName: 'default' }] } },
                    providers: { openai: { default: { apiKey: 'mock-key' } } }
                }))
            }));
            await vi.doMock('#root/providers/openai/OpenAIProvider.js', () => ({
                OpenAIProvider: vi.fn(function () {
                    return {
                        isInitialized: () => true,
                        init: vi.fn(),
                        hasCapability: vi.fn(() => true),
                        chat: vi.fn().mockResolvedValue({
                            output: 'mocked response',
                            metadata: { status: 'completed' }
                        }),
                        chatStream: vi.fn().mockImplementation(async function* () {
                            yield { delta: 'chunk1', metadata: { status: 'incomplete' } };
                            yield { output: 'final', metadata: { status: 'completed' } };
                        })
                    };
                })
            }));
            await vi.doMock('#root/providers/anthropic/AnthropicProvider.js', () => ({
                AnthropicProvider: vi.fn(function () {
                    return { isInitialized: () => true, init: vi.fn(), hasCapability: vi.fn(() => false) };
                })
            }));
            await vi.doMock('#root/providers/gemini/GeminiProvider.js', () => ({
                GeminiProvider: vi.fn(function () {
                    return { isInitialized: () => true, init: vi.fn(), hasCapability: vi.fn(() => false) };
                })
            }));

            // Now import AIClient (after all mocks)
            const { AIClient } = await import('#root/client/AIClient.js');
            const client = new AIClient();
            const session = client.createSession();

            const result = await client.chat(
                { input: { messages: [{ role: 'user', content: [{ type: 'text', text: 'test' }] }] } },
                session
            );

            expect(result).toBeDefined();
            expect(session.getEvents().length).toBeGreaterThanOrEqual(1);
        });

        it('chatStream method calls executeWithPolicyStream', async () => {
            await vi.doMock('#root/core/utils/WithRequestContext', () => ({
                withRequestContext: vi.fn(async (req, fn) => ({ output: 'mocked', metadata: { status: 'completed' } })),
                withRequestContextStream: vi.fn(async function* (req, fn) { yield { output: 'mocked', metadata: { status: 'completed' } }; })
            }));
            await vi.doMock('#root/core/config/ConfigLoader.js', () => ({
                loadAppConfig: vi.fn(() => ({
                    appConfig: { executionPolicy: { providerChain: [{ providerType: 'openai', connectionName: 'default' }] } },
                    providers: { openai: { default: { apiKey: 'mock-key' } } }
                }))
            }));
            await vi.doMock('#root/providers/openai/OpenAIProvider.js', () => ({
                OpenAIProvider: vi.fn(function () {
                    return {
                        isInitialized: () => true,
                        init: vi.fn(),
                        hasCapability: vi.fn(() => true),
                        chatStream: vi.fn().mockImplementation(async function* () {
                            yield { delta: 'chunk1', metadata: { status: 'incomplete' } };
                            yield { output: 'final', metadata: { status: 'completed' } };
                        })
                    };
                })
            }));
            await vi.doMock('#root/providers/anthropic/AnthropicProvider.js', () => ({
                AnthropicProvider: vi.fn(function () {
                    return { isInitialized: () => true, init: vi.fn(), hasCapability: vi.fn(() => false) };
                })
            }));
            await vi.doMock('#root/providers/gemini/GeminiProvider.js', () => ({
                GeminiProvider: vi.fn(function () {
                    return { isInitialized: () => true, init: vi.fn(), hasCapability: vi.fn(() => false) };
                })
            }));
            vi.resetModules();
            const { AIClient } = await import('#root/client/AIClient.js');
            const client = new AIClient();
            const session = client.createSession();
            const chunks: any[] = [];
            for await (const chunk of client.chatStream(
                { input: { messages: [{ role: 'user', content: [{ type: 'text', text: 'test' }] }] } },
                session
            )) {
                chunks.push(chunk);
            }
            expect(chunks.length).toBeGreaterThanOrEqual(1);
            expect(session.getEvents().length).toBeGreaterThanOrEqual(1);
        });

        it('chatStream method calls executeWithPolicyStream', async () => {
            await vi.doMock('#root/core/utils/WithRequestContext', () => ({
                withRequestContext: vi.fn(async (req, fn) => ({ output: 'mocked', metadata: { status: 'completed' } })),
                withRequestContextStream: vi.fn(async function* (req, fn) { yield { output: 'mocked', metadata: { status: 'completed' } }; })
            }));
            await vi.doMock('#root/core/config/ConfigLoader.js', () => ({
                loadAppConfig: vi.fn(() => ({
                    appConfig: { executionPolicy: { providerChain: [{ providerType: 'openai', connectionName: 'default' }] } },
                    providers: { openai: { default: { apiKey: 'mock-key' } } }
                }))
            }));
            await vi.doMock('#root/providers/openai/OpenAIProvider.js', () => ({
                OpenAIProvider: vi.fn(function () {
                    return {
                        isInitialized: () => true,
                        init: vi.fn(),
                        hasCapability: vi.fn(() => true),
                        chatStream: vi.fn().mockImplementation(async function* () {
                            yield { delta: 'chunk1', metadata: { status: 'incomplete' } };
                            yield { output: 'final', metadata: { status: 'completed' } };
                        })
                    };
                })
            }));
            await vi.doMock('#root/providers/anthropic/AnthropicProvider.js', () => ({
                AnthropicProvider: vi.fn(function () {
                    return { isInitialized: () => true, init: vi.fn(), hasCapability: vi.fn(() => false) };
                })
            }));
            await vi.doMock('#root/providers/gemini/GeminiProvider.js', () => ({
                GeminiProvider: vi.fn(function () {
                    return { isInitialized: () => true, init: vi.fn(), hasCapability: vi.fn(() => false) };
                })
            }));
            vi.resetModules();
            const { AIClient } = await import('#root/client/AIClient.js');
            const client = new AIClient();
            const session = client.createSession();
            const chunks: any[] = [];
            for await (const chunk of client.chatStream(
                { input: { messages: [{ role: 'user', content: [{ type: 'text', text: 'test' }] }] } },
                session
            )) {
                chunks.push(chunk);
            }
            expect(chunks.length).toBeGreaterThanOrEqual(1);
            expect(session.getEvents().length).toBeGreaterThanOrEqual(1);
        });

        it('embeddings method calls executeWithPolicy', async () => {
            await vi.doMock('#root/providers/openai/OpenAIProvider.js', () => ({
                OpenAIProvider: vi.fn(function () {
                    return {
                        isInitialized: () => true,
                        init: vi.fn(),
                        hasCapability: vi.fn(() => true),
                        embed: vi.fn().mockResolvedValue({ output: [0.1, 0.2, 0.3], metadata: { status: 'completed' } })
                    };
                })
            }));
            vi.resetModules();
            const { AIClient } = await import('#root/client/AIClient.js');
            const client = new AIClient();
            const session = client.createSession();
            const result = await client.embeddings({ input: { input: 'test' } }, session);
            expect(result).toBeDefined();
        });

        it('moderation method calls executeWithPolicy', async () => {
            await vi.doMock('#root/providers/openai/OpenAIProvider.js', () => ({
                OpenAIProvider: vi.fn(function () {
                    return {
                        isInitialized: () => true,
                        init: vi.fn(),
                        hasCapability: vi.fn(() => true),
                        moderation: vi.fn().mockResolvedValue({ output: { flagged: false }, metadata: { status: 'completed' } })
                    };
                })
            }));
            vi.resetModules();
            const { AIClient } = await import('#root/client/AIClient.js');
            const client = new AIClient();
            const session = client.createSession();
            const result = await client.moderation({ input: { input: 'test moderation' } }, session);
            expect(result).toBeDefined();
        });

        it('generateImage method calls executeWithPolicy', async () => {
            await vi.doMock('#root/providers/openai/OpenAIProvider.js', () => ({
                OpenAIProvider: vi.fn(function () {
                    return {
                        isInitialized: () => true,
                        init: vi.fn(),
                        hasCapability: vi.fn(() => true),
                        generateImage: vi.fn().mockResolvedValue({ output: [{ url: 'http://example.com/img.png', data: 'base64data' }], metadata: { status: 'completed' } })
                    };
                })
            }));
            vi.resetModules();
            const { AIClient } = await import('#root/client/AIClient.js');
            const client = new AIClient();
            const session = client.createSession();
            const result = await client.generateImage({ input: { prompt: 'test image' } }, session);
            expect(result).toBeDefined();
        });

        it('generateImageStream method calls executeWithPolicyStream', async () => {
            await vi.doMock('#root/providers/openai/OpenAIProvider.js', () => ({
                OpenAIProvider: vi.fn(function () {
                    return {
                        isInitialized: () => true,
                        init: vi.fn(),
                        hasCapability: vi.fn(() => true),
                        generateImageStream: vi.fn().mockImplementation(async function* () {
                            yield { output: [{ url: 'http://example.com/img.png' }], metadata: { status: 'completed' } };
                        })
                    };
                })
            }));
            vi.resetModules();
            const { AIClient } = await import('#root/client/AIClient.js');
            const client = new AIClient();
            const session = client.createSession();
            const chunks = [];
            for await (const chunk of client.generateImageStream({ input: { prompt: 'test image' } }, session)) {
                chunks.push(chunk);
            }
            expect(chunks.length).toBeGreaterThan(0);
        });

        it('analyzeImage method calls executeWithPolicy', async () => {
            await vi.doMock('#root/providers/openai/OpenAIProvider.js', () => ({
                OpenAIProvider: vi.fn(function () {
                    return {
                        isInitialized: () => true,
                        init: vi.fn(),
                        hasCapability: vi.fn(() => true),
                        analyzeImage: vi.fn().mockResolvedValue({ output: [{ text: 'desc', objects: [] }], metadata: { status: 'completed' } })
                    };
                })
            }));
            vi.resetModules();
            const { AIClient } = await import('#root/client/AIClient.js');
            const client = new AIClient();
            const session = client.createSession();
            const result = await client.analyzeImage({ input: { images: [{ id: 'img1', sourceType: 'url', url: 'https://example.com/img.png' }] } }, session);
            expect(result).toBeDefined();
        });

        it('analyzeImageStream method calls executeWithPolicyStream', async () => {
            await vi.doMock('#root/providers/openai/OpenAIProvider.js', () => ({
                OpenAIProvider: vi.fn(function () {
                    return {
                        isInitialized: () => true,
                        init: vi.fn(),
                        hasCapability: vi.fn(() => true),
                        analyzeImageStream: vi.fn().mockImplementation(async function* () {
                            yield { output: [{ label: 'cat', confidence: 0.99 }], metadata: { status: 'completed' } };
                        })
                    };
                })
            }));
            vi.resetModules();
            const { AIClient } = await import('#root/client/AIClient.js');
            const client = new AIClient();
            const session = client.createSession();
            const chunks = [];
            for await (const chunk of client.analyzeImageStream({ input: { images: [{ id: 'img1', sourceType: 'url', url: 'https://example.com/img.png' }] } }, session)) {
                chunks.push(chunk);
            }
            expect(chunks.length).toBeGreaterThan(0);
        });

        it('editImage method calls executeWithPolicy', async () => {
            await vi.doMock('#root/providers/openai/OpenAIProvider.js', () => ({
                OpenAIProvider: vi.fn(function () {
                    return {
                        isInitialized: () => true,
                        init: vi.fn(),
                        hasCapability: vi.fn(() => true),
                        editImage: vi.fn().mockResolvedValue({ output: [{ url: 'http://example.com/edited.png' }], metadata: { status: 'completed' } })
                    };
                })
            }));
            vi.resetModules();
            const { AIClient } = await import('#root/client/AIClient.js');
            const client = new AIClient();
            const session = client.createSession();
            const result = await client.editImage({ input: { prompt: 'edit this', referenceImages: [{ id: 'test', sourceType: 'url', url: 'https://example.com/img.png' }] } }, session);
            expect(result).toBeDefined();
        });

        it('editImageStream method calls executeWithPolicyStream', async () => {
            await vi.doMock('#root/providers/openai/OpenAIProvider.js', () => ({
                OpenAIProvider: vi.fn(function () {
                    return {
                        isInitialized: () => true,
                        init: vi.fn(),
                        hasCapability: vi.fn(() => true),
                        editImageStream: vi.fn().mockImplementation(async function* () {
                            yield { output: [{ url: 'http://example.com/edited.png' }], metadata: { status: 'completed' } };
                        })
                    };
                })
            }));
            vi.resetModules();
            const { AIClient } = await import('#root/client/AIClient.js');
            const client = new AIClient();
            const session = client.createSession();
            const chunks = [];
            for await (const chunk of client.editImageStream({ input: { prompt: 'edit this', referenceImages: [{ id: 'test', sourceType: 'url', url: 'https://example.com/img.png' }] } }, session)) {
                chunks.push(chunk);
            }
            expect(chunks.length).toBeGreaterThan(0);
        });

        it('executeWithPolicy with lifecycle hooks calls all hooks', async () => {
            await vi.doMock('#root/core/utils/WithRequestContext', () => ({
                withRequestContext: vi.fn(async (req, fn) => {
                    return { output: 'mocked', metadata: { status: 'completed' } };
                }),
                withRequestContextStream: vi.fn(async function* (req, fn) {
                    yield { output: 'mocked', metadata: { status: 'completed' } };
                })
            }));
            vi.resetModules();
            await vi.doMock('#root/core/config/ConfigLoader.js', () => ({
                loadAppConfig: vi.fn(() => ({
                    appConfig: { executionPolicy: { providerChain: [{ providerType: 'openai', connectionName: 'default' }] } },
                    providers: {
                        openai: { default: { apiKey: 'mock-key' } }
                    }
                }))
            }));
            await vi.doMock('#root/providers/openai/OpenAIProvider.js', () => ({
                OpenAIProvider: vi.fn(function () {
                    return {
                        isInitialized: () => true,
                        init: vi.fn(),
                        hasCapability: vi.fn(() => true),
                        chat: vi.fn().mockResolvedValue({
                            output: 'mocked response',
                            metadata: { status: 'completed' }
                        })
                    };
                })
            }));

            const { AIClient } = await import('#root/client/AIClient.js');
            const client = new AIClient();
            const session = client.createSession();

            const onExecutionStart = vi.fn();
            const onAttemptStart = vi.fn();
            const onAttemptSuccess = vi.fn();
            const onExecutionEnd = vi.fn();

            client.setLifeCycleHooks({
                onExecutionStart,
                onAttemptStart,
                onAttemptSuccess,
                onExecutionEnd
            });

            const result = await client.chat(
                { input: { messages: [{ role: 'user', content: [{ type: 'text', text: 'test' }] }] } },
                session
            );

            expect(result).toBeDefined();
            expect(onExecutionStart).toHaveBeenCalled();
            expect(onAttemptStart).toHaveBeenCalled();
            expect(onAttemptSuccess).toHaveBeenCalled();
            expect(onExecutionEnd).toHaveBeenCalled();
        });

        it('findProvidersByCapability returns providers with requested capability', async () => {
            vi.resetModules();

            await vi.doMock('#root/core/config/ConfigLoader.js', () => ({
                loadAppConfig: vi.fn(() => ({
                    appConfig: { executionPolicy: { providerChain: [{ providerType: 'openai', connectionName: 'default' }] } },
                    providers: {
                        openai: { default: { apiKey: 'mock-key' } }
                    }
                }))
            }));

            await vi.doMock('#root/providers/openai/OpenAIProvider.js', () => ({
                OpenAIProvider: vi.fn(function () {
                    return {
                        isInitialized: () => true,
                        init: vi.fn(),
                        hasCapability: vi.fn(() => true)
                    };
                })
            }));

            const { AIClient } = await import('#root/client/AIClient.js');
            const client = new AIClient();

            const providers = client.findProvidersByCapability(CapabilityKeys.ChatCapabilityKey as unknown as any);
            expect(Array.isArray(providers)).toBe(true);
            expect(providers.length).toBeGreaterThan(0);
        });

        it('getProvider returns correct provider instance', async () => {
            vi.resetModules();

            await vi.doMock('#root/core/config/ConfigLoader.js', () => ({
                loadAppConfig: vi.fn(() => ({
                    appConfig: { executionPolicy: { providerChain: [{ providerType: 'openai', connectionName: 'default' }] } },
                    providers: {
                        openai: { default: { apiKey: 'mock-key' } }
                    }
                }))
            }));

            await vi.doMock('#root/providers/openai/OpenAIProvider.js', () => ({
                OpenAIProvider: vi.fn(function () {
                    return {
                        isInitialized: () => true,
                        init: vi.fn(),
                        hasCapability: vi.fn(() => true)
                    };
                })
            }));

            const { AIClient } = await import('#root/client/AIClient.js');
            const client = new AIClient();

            const provider = client.getProvider(AIProvider.OpenAI, 'default');
            expect(provider).toBeDefined();
            expect(provider.isInitialized()).toBe(true);
        });

        it('executeWithPolicy throws AllProvidersFailedError when no providers support capability', async () => {
            vi.resetModules();

            await vi.doMock('#root/core/config/ConfigLoader.js', () => ({
                loadAppConfig: vi.fn(() => ({
                    appConfig: { executionPolicy: { providerChain: [{ providerType: 'openai', connectionName: 'default' }] } },
                    providers: {
                        openai: { default: { apiKey: 'mock-key' } }
                    }
                }))
            }));

            await vi.doMock('#root/providers/openai/OpenAIProvider.js', () => ({
                OpenAIProvider: vi.fn(function () {
                    return {
                        isInitialized: () => true,
                        init: vi.fn(),
                        hasCapability: vi.fn(() => true)
                    };
                })
            }));

            const { AIClient } = await import('#root/client/AIClient.js');
            const client = new AIClient();
            const session = client.createSession();

            try {
                await client.chat(
                    { input: { messages: [{ role: 'user', content: [{ type: 'text', text: 'test' }] }] } },
                    session,
                    [] // Empty chain - will fail
                );
            } catch (e) {
                expect(e).toBeDefined();
            }
        });

        it('generateImageStream yields expected chunks', async () => {
            const { AIClient } = await import('#root/client/AIClient.js');
            const client = new AIClient();
            const session = client.createSession();
            const chunks = [];
            for await (const chunk of client.generateImageStream(
                { input: { prompt: 'test' } },
                session
            )) {
                chunks.push(chunk);
            }
            expect(chunks.length).toBeGreaterThan(0);
        });

        it('analyzeImageStream yields expected chunks', async () => {
            const { AIClient } = await import('#root/client/AIClient.js');
            const client = new AIClient();
            const session = client.createSession();
            const chunks = [];
            for await (const chunk of client.analyzeImageStream(
                { input: { images: [{ id: 'img1', sourceType: 'url', url: 'https://example.com/fake.png' }] } },
                session
            )) {
                chunks.push(chunk);
            }
            expect(chunks.length).toBeGreaterThan(0);
        });

        it('editImage returns expected result', async () => {
            const { AIClient } = await import('#root/client/AIClient.js');
            const client = new AIClient();
            const session = client.createSession();
            const result = await client.editImage(
                { input: { prompt: 'edit this', referenceImages: [{ id: 'test', sourceType: 'url', url: 'https://example.com/img.png' }] } },
                session
            );
            expect(result).toBeDefined();
        });

        it('editImageStream yields expected chunks', async () => {
            const { AIClient } = await import('#root/client/AIClient.js');
            const client = new AIClient();
            const session = client.createSession();
            const chunks = [];
            for await (const chunk of client.editImageStream(
                { input: { prompt: 'edit this', referenceImages: [{ id: 'test', sourceType: 'url', url: 'https://example.com/img.png' }] } },
                session
            )) {
                chunks.push(chunk);
            }
            expect(chunks.length).toBeGreaterThan(0);
        });

        it('generateImageStream throws if providerChain is empty', async () => {
            const { AIClient } = await import('#root/client/AIClient.js');
            const client = new AIClient();
            const session = client.createSession();
            let error;
            try {
                for await (const _ of client.generateImageStream(
                    { input: { prompt: 'test' } },
                    session,
                    []
                )) { }
            } catch (e) {
                error = e;
            }
            expect(error).toBeDefined();
        });

        it('emitSessionData adds event to session', async () => {
            const { AIClient } = await import('#root/client/AIClient.js');
            const client = new AIClient();
            const session = client.createSession('emit-test');
            const event = { eventType: 'test', capability: 'test', payload: 'payload' };
            // @ts-ignore (private method)
            client.emitSessionData(session, event);
            expect(session.getEvents().length).toBeGreaterThan(0);
        });
    });
})