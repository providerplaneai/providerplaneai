import { vi } from 'vitest';

// Fully mock OpenAIProvider
vi.mock('#root/providers/openai/OpenAIProvider.js', () => ({
    OpenAIProvider: vi.fn(function () {
        return {
            isInitialized: () => true,
            init: vi.fn(),
            hasCapability: vi.fn(() => true),
            chat: vi.fn().mockResolvedValue({ output: 'mocked', metadata: { status: 'completed' } }),
            chatStream: vi.fn().mockImplementation(async function* () {
                yield { output: 'mocked', metadata: { status: 'completed' } };
            }),
            embed: vi.fn().mockResolvedValue({ output: [0.1, 0.2, 0.3], metadata: { status: 'completed' } }),
            moderation: vi.fn().mockResolvedValue({ output: { flagged: false }, metadata: { status: 'completed' } }),
            generateImage: vi.fn().mockResolvedValue({ output: [{ url: 'http://example.com/img.png', data: 'base64data' }], metadata: { status: 'completed' } }),
            generateImageStream: vi.fn().mockImplementation(async function* () {
                yield { output: [{ url: 'http://example.com/img.png' }], metadata: { status: 'completed' } };
            }),
            analyzeImage: vi.fn().mockResolvedValue({ output: [{ text: 'image description', objects: [] }], metadata: { status: 'completed' } }),
            analyzeImageStream: vi.fn().mockImplementation(async function* () {
                yield { output: [{ label: 'cat', confidence: 0.99 }], metadata: { status: 'completed' } };
            }),
            editImage: vi.fn().mockResolvedValue({ output: [{ url: 'http://example.com/edited.png' }], metadata: { status: 'completed' } }),
            editImageStream: vi.fn().mockImplementation(async function* () {
                yield { output: [{ url: 'http://example.com/edited.png' }], metadata: { status: 'completed' } };
            }),
            // Capability delegates
            chatDelegate: {
                chat: vi.fn().mockResolvedValue({ output: 'mocked', metadata: { status: 'completed' } }),
                chatStream: vi.fn().mockImplementation(async function* () {
                    yield { output: 'mocked', metadata: { status: 'completed' } };
                })
            },
            embedDelegate: {
                embed: vi.fn().mockResolvedValue({ output: [0.1, 0.2, 0.3], metadata: { status: 'completed' } })
            },
            moderateDelegate: {
                moderation: vi.fn().mockResolvedValue({ output: { flagged: false }, metadata: { status: 'completed' } })
            },
            imageEditDelegate: {
                editImage: vi.fn().mockResolvedValue({ output: [{ url: 'http://example.com/edited.png' }], metadata: { status: 'completed' } }),
                editImageStream: vi.fn().mockImplementation(async function* () {
                    yield { output: [{ url: 'http://example.com/edited.png' }], metadata: { status: 'completed' } };
                })
            },
            imageGenDelegate: {
                generateImage: vi.fn().mockResolvedValue({ output: [{ url: 'http://example.com/img.png', data: 'base64data' }], metadata: { status: 'completed' } }),
                generateImageStream: vi.fn().mockImplementation(async function* () {
                    yield { output: [{ url: 'http://example.com/img.png' }], metadata: { status: 'completed' } };
                })
            },
            imageAnalysisDelegate: {
                analyzeImage: vi.fn().mockResolvedValue({ output: [{ text: 'image description', objects: [] }], metadata: { status: 'completed' } }),
                analyzeImageStream: vi.fn().mockImplementation(async function* () {
                    yield { output: [{ label: 'cat', confidence: 0.99 }], metadata: { status: 'completed' } };
                })
            }
        };
    })
}));

// Fully mock AnthropicProvider
vi.mock('#root/providers/anthropic/AnthropicProvider.js', () => ({
    AnthropicProvider: vi.fn(function () {
        return {
            isInitialized: () => true,
            init: vi.fn(),
            hasCapability: vi.fn(() => true),
            chat: vi.fn().mockResolvedValue({ output: 'mocked', metadata: { status: 'completed' } }),
            chatStream: vi.fn().mockImplementation(async function* () {
                yield { output: 'mocked', metadata: { status: 'completed' } };
            }),
            embed: vi.fn().mockResolvedValue({ output: [0.1, 0.2, 0.3], metadata: { status: 'completed' } }),
            moderation: vi.fn().mockResolvedValue({ output: { flagged: false }, metadata: { status: 'completed' } }),
            // Capability delegates
            chatDelegate: {
                chat: vi.fn().mockResolvedValue({ output: 'mocked', metadata: { status: 'completed' } }),
                chatStream: vi.fn().mockImplementation(async function* () {
                    yield { output: 'mocked', metadata: { status: 'completed' } };
                })
            },
            embedDelegate: {
                embed: vi.fn().mockResolvedValue({ output: [0.1, 0.2, 0.3], metadata: { status: 'completed' } })
            },
            moderateDelegate: {
                moderation: vi.fn().mockResolvedValue({ output: { flagged: false }, metadata: { status: 'completed' } })
            }
        };
    })
}));

// Fully mock GeminiProvider
vi.mock('#root/providers/gemini/GeminiProvider.js', () => ({
    GeminiProvider: vi.fn(function () {
        return {
            isInitialized: () => true,
            init: vi.fn(),
            hasCapability: vi.fn(() => true),
            chat: vi.fn().mockResolvedValue({ output: 'mocked', metadata: { status: 'completed' } }),
            chatStream: vi.fn().mockImplementation(async function* () {
                yield { output: 'mocked', metadata: { status: 'completed' } };
            }),
            embed: vi.fn().mockResolvedValue({ output: [0.1, 0.2, 0.3], metadata: { status: 'completed' } }),
            moderation: vi.fn().mockResolvedValue({ output: { flagged: false }, metadata: { status: 'completed' } }),
            generateImage: vi.fn().mockResolvedValue({ output: [{ url: 'http://example.com/img.png', data: 'base64data' }], metadata: { status: 'completed' } }),
            analyzeImage: vi.fn().mockResolvedValue({ output: [{ text: 'image description', objects: [] }], metadata: { status: 'completed' } }),
            // Capability delegates
            chatDelegate: {
                chat: vi.fn().mockResolvedValue({ output: 'mocked', metadata: { status: 'completed' } }),
                chatStream: vi.fn().mockImplementation(async function* () {
                    yield { output: 'mocked', metadata: { status: 'completed' } };
                })
            },
            embedDelegate: {
                embed: vi.fn().mockResolvedValue({ output: [0.1, 0.2, 0.3], metadata: { status: 'completed' } })
            },
            moderationDelegate: {
                moderation: vi.fn().mockResolvedValue({ output: { flagged: false }, metadata: { status: 'completed' } })
            },
            imageGenerationDelegate: {
                generateImage: vi.fn().mockResolvedValue({ output: [{ url: 'http://example.com/img.png', data: 'base64data' }], metadata: { status: 'completed' } })
            },
            imageAnalysisDelegate: {
                analyzeImage: vi.fn().mockResolvedValue({ output: [{ text: 'image description', objects: [] }], metadata: { status: 'completed' } })
            }
        };
    })
}));

// Mock #root/index.js utility/context methods
vi.mock('#root/index.js', async (importOriginal) => {
    const actual = await importOriginal();
    return Object.assign({}, actual, {
        withRequestContext: vi.fn(async (req, fn) => {
            return { output: 'mocked', metadata: { status: 'completed' } };
        }),
        withRequestContextStream: vi.fn(async function* (req, fn) {
            yield { output: 'mocked', metadata: { status: 'completed' } };
        })
    });
});
