import { beforeEach, describe, expect, it, vi } from "vitest";

const mistralConstructor = vi.hoisted(
    () =>
        vi.fn(function MistralMock() {
            return {
                chat: {},
                embeddings: {},
                classifiers: {},
                ocr: {},
                files: {},
                audio: {
                    transcriptions: {},
                    speech: {}
                }
            };
        })
);
vi.mock("@mistralai/mistralai", () => ({ Mistral: mistralConstructor }));

beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("#root/index.js");
    vi.doUnmock("#root/providers/mistral/MistralProvider.js");
});

const config = { apiKey: "mistral-key", apiKeyEnvVar: "MISTRAL_API_KEY", providerDefaults: {} } as any;

describe("MistralProvider", () => {
    it("throws when init is called without apiKey", async () => {
        const { MistralProvider } = await import("#root/providers/mistral/MistralProvider.js");
        const provider = new MistralProvider();
        expect(() => provider.init({ apiKeyEnvVar: "MISTRAL_API_KEY" } as any)).toThrow("Mistral API key");
    });

    it("registers v1 capabilities on init", async () => {
        const { MistralProvider } = await import("#root/providers/mistral/MistralProvider.js");
        const { CapabilityKeys } = await import("#root/index.js");
        const provider = new MistralProvider();

        provider.init(config);

        expect(mistralConstructor).toHaveBeenCalled();
        expect(provider.hasCapability(CapabilityKeys.ChatCapabilityKey)).toBe(true);
        expect(provider.hasCapability(CapabilityKeys.ChatStreamCapabilityKey)).toBe(true);
        expect(provider.hasCapability(CapabilityKeys.EmbedCapabilityKey)).toBe(true);
        expect(provider.hasCapability(CapabilityKeys.ModerationCapabilityKey)).toBe(true);
        expect(provider.hasCapability(CapabilityKeys.ImageAnalysisCapabilityKey)).toBe(true);
        expect(provider.hasCapability(CapabilityKeys.ImageAnalysisStreamCapabilityKey)).toBe(true);
        expect(provider.hasCapability(CapabilityKeys.OCRCapabilityKey)).toBe(true);
        expect(provider.hasCapability(CapabilityKeys.AudioTranscriptionCapabilityKey)).toBe(true);
        expect(provider.hasCapability(CapabilityKeys.AudioTranscriptionStreamCapabilityKey)).toBe(true);
        expect(provider.hasCapability(CapabilityKeys.AudioTextToSpeechCapabilityKey)).toBe(true);
        expect(provider.hasCapability(CapabilityKeys.AudioTextToSpeechStreamCapabilityKey)).toBe(true);
    });

    it("passes provider-level providerParams into the Mistral SDK constructor", async () => {
        const { MistralProvider } = await import("#root/providers/mistral/MistralProvider.js");
        const provider = new MistralProvider();

        provider.init({
            apiKey: "mistral-key",
            apiKeyEnvVar: "MISTRAL_API_KEY",
            defaultModels: {},
            models: {},
            providerDefaults: {
                providerParams: {
                    timeout: 45_000,
                    headers: { "x-test": "mistral" }
                }
            }
        } as any);

        expect(mistralConstructor).toHaveBeenCalledWith(
            expect.objectContaining({
                apiKey: "mistral-key",
                timeout: 45_000,
                headers: { "x-test": "mistral" }
            })
        );
    });

    it("forwards to delegates and throws when a delegate is missing", async () => {
        const { MistralProvider } = await import("#root/providers/mistral/MistralProvider.js");
        const { CapabilityUnsupportedError, MultiModalExecutionContext } = await import("#root/index.js");

        const provider = new MistralProvider();
        const ctx = new MultiModalExecutionContext();

        (provider as any).chatDelegate = {
            chat: vi.fn().mockResolvedValue({ output: { role: "assistant", content: [] } }),
            chatStream: vi.fn().mockReturnValue((async function* () { yield { done: true }; })())
        };
        (provider as any).embedDelegate = { embed: vi.fn().mockResolvedValue({ output: [] }) };
        (provider as any).moderationDelegate = { moderation: vi.fn().mockResolvedValue({ output: [] }) };
        (provider as any).imageAnalysisDelegate = {
            analyzeImage: vi.fn().mockResolvedValue({ output: [] }),
            analyzeImageStream: vi.fn().mockReturnValue((async function* () { yield { done: true }; })())
        };
        (provider as any).ocrDelegate = { ocr: vi.fn().mockResolvedValue({ output: [] }) };
        (provider as any).audioTranscriptionDelegate = {
            transcribeAudio: vi.fn().mockResolvedValue({ output: [] }),
            transcribeAudioStream: vi.fn().mockReturnValue((async function* () { yield { done: true }; })())
        };
        (provider as any).audioTtsDelegate = {
            textToSpeech: vi.fn().mockResolvedValue({ output: [] }),
            textToSpeechStream: vi.fn().mockReturnValue((async function* () { yield { done: true }; })())
        };

        await expect(provider.chat({ input: { messages: [{ role: "user", content: [{ type: "text", text: "x" }] }] } } as any, ctx)).resolves.toHaveProperty(
            "output"
        );
        await expect(provider.embed({ input: { input: "x" } } as any, ctx)).resolves.toMatchObject({ output: [] });
        await expect(provider.moderation({ input: { input: "x" } } as any, ctx)).resolves.toMatchObject({ output: [] });
        await expect(provider.analyzeImage({ input: { images: [{ id: "img1", sourceType: "base64", base64: "QQ==" }] } } as any, ctx)).resolves.toMatchObject({
            output: []
        });
        await expect(provider.ocr({ input: { file: "https://example.com/test.pdf" } } as any, ctx)).resolves.toMatchObject({ output: [] });
        await expect(provider.chatStream({ input: { messages: [{ role: "user", content: [{ type: "text", text: "x" }] }] } } as any, ctx).next()).resolves.toMatchObject({
            done: false
        });
        await expect(provider.transcribeAudio({ input: { file: Buffer.from("abc") } } as any, ctx)).resolves.toMatchObject({ output: [] });
        await expect(provider.transcribeAudioStream({ input: { file: Buffer.from("abc") } } as any, ctx).next()).resolves.toMatchObject({
            done: false
        });
        await expect(provider.textToSpeech({ input: { text: "hello", voice: "voice-1" } } as any, ctx)).resolves.toMatchObject({ output: [] });
        await expect(provider.textToSpeechStream({ input: { text: "hello", voice: "voice-1" } } as any, ctx).next()).resolves.toMatchObject({
            done: false
        });

        (provider as any).chatDelegate = null;
        await expect(provider.chat({ input: { messages: [{ role: "user", content: [{ type: "text", text: "x" }] }] } } as any, ctx)).rejects.toBeInstanceOf(
            CapabilityUnsupportedError
        );
    });

    it("uses base provider option merging without Mistral-specific validation", async () => {
        const { MistralProvider } = await import("#root/providers/mistral/MistralProvider.js");
        const { CapabilityKeys } = await import("#root/index.js");

        const provider = new MistralProvider();
        provider.init({
            apiKey: "mistral-key",
            apiKeyEnvVar: "MISTRAL_API_KEY",
            defaultModel: "mistral-small-latest",
            defaultModels: {
                chat: "mistral-small-latest",
                ocr: "mistral-ocr-latest",
                audioTranscription: "voxtral-mini-latest",
                audioTts: "voxtral-mini-tts-2603"
            },
            models: {
                "mistral-small-latest": {
                    chat: {}
                },
                "mistral-ocr-latest": {
                    ocr: {
                        modelParams: { tableFormat: "markdown" },
                        providerParams: { timeoutMs: 10_000 },
                        generalParams: { preserveUnknown: true }
                    }
                },
                "voxtral-mini-latest": {
                    audioTranscription: {
                        modelParams: { language: "en", temperature: 0.1, contextBias: "billing" },
                        generalParams: { audioStreamBatchSize: 16 }
                    }
                },
                "voxtral-mini-tts-2603": {
                    audioTts: {
                        modelParams: { voiceId: "voice-1", responseFormat: "mp3" },
                        generalParams: { audioStreamBatchSize: 32 }
                    }
                }
            },
            providerDefaults: {
                generalParams: { inherited: true }
            }
        } as any);

        expect(
            provider.getMergedOptions(CapabilityKeys.OCRCapabilityKey, {
                model: "mistral-ocr-latest",
                modelParams: { documentAnnotationFormat: { type: "json" } },
                providerParams: { timeoutMs: 20_000 },
                generalParams: { chatStreamBatchSize: 8 }
            })
        ).toMatchObject({
            model: "mistral-ocr-latest",
            modelParams: {
                tableFormat: "markdown",
                documentAnnotationFormat: { type: "json" }
            },
            providerParams: { timeoutMs: 20_000 },
            generalParams: {
                inherited: true,
                preserveUnknown: true,
                chatStreamBatchSize: 8
            }
        });

        expect(
            provider.getMergedOptions(CapabilityKeys.AudioTranscriptionCapabilityKey, {
                model: "voxtral-mini-latest",
                modelParams: { language: "fr", temperature: 0.2, contextBias: "support" },
                providerParams: { retries: 2 },
                generalParams: { audioStreamBatchSize: 64, custom: true }
            })
        ).toMatchObject({
            model: "voxtral-mini-latest",
            modelParams: { language: "fr", temperature: 0.2, contextBias: "support" },
            providerParams: { retries: 2 },
            generalParams: {
                inherited: true,
                audioStreamBatchSize: 64,
                custom: true
            }
        });

        expect(
            provider.getMergedOptions(CapabilityKeys.AudioTextToSpeechCapabilityKey, {
                model: "voxtral-mini-tts-2603",
                modelParams: { voiceId: "voice-2" },
                generalParams: { audioStreamBatchSize: 128 }
            })
        ).toMatchObject({
            model: "voxtral-mini-tts-2603",
            modelParams: { voiceId: "voice-2", responseFormat: "mp3" },
            generalParams: {
                inherited: true,
                audioStreamBatchSize: 128
            }
        });

        expect(
            provider.getMergedOptions(CapabilityKeys.ChatCapabilityKey, {
                modelParams: { temperature: 0.4 },
                generalParams: { chatStreamBatchSize: 128 }
            })
        ).toMatchObject({
            modelParams: { temperature: 0.4 },
            generalParams: { inherited: true, chatStreamBatchSize: 128 }
        });
    });

    it("throws unsupported errors for every missing delegate path", async () => {
        const { MistralProvider } = await import("#root/providers/mistral/MistralProvider.js");
        const { CapabilityUnsupportedError, MultiModalExecutionContext } = await import("#root/index.js");

        const provider = new MistralProvider();
        const ctx = new MultiModalExecutionContext();

        expect(() =>
            provider.chatStream({ input: { messages: [{ role: "user", content: [{ type: "text", text: "x" }] }] } } as any, ctx)
        ).toThrow(CapabilityUnsupportedError);
        await expect(provider.embed({ input: { input: "x" } } as any, ctx)).rejects.toBeInstanceOf(CapabilityUnsupportedError);
        await expect(provider.moderation({ input: { input: "x" } } as any, ctx)).rejects.toBeInstanceOf(CapabilityUnsupportedError);
        await expect(provider.ocr({ input: { file: "https://example.com/test.pdf" } } as any, ctx)).rejects.toBeInstanceOf(CapabilityUnsupportedError);
        await expect(
            provider.analyzeImage({ input: { images: [{ id: "img1", sourceType: "url", url: "https://example.com/img.png" }] } } as any, ctx)
        ).rejects.toBeInstanceOf(CapabilityUnsupportedError);
        expect(() =>
            provider.analyzeImageStream(
                { input: { images: [{ id: "img1", sourceType: "url", url: "https://example.com/img.png" }] } } as any,
                ctx
            )
        ).toThrow(CapabilityUnsupportedError);
        await expect(provider.transcribeAudio({ input: { file: Buffer.from("abc") } } as any, ctx)).rejects.toBeInstanceOf(
            CapabilityUnsupportedError
        );
        expect(() => provider.transcribeAudioStream({ input: { file: Buffer.from("abc") } } as any, ctx)).toThrow(
            CapabilityUnsupportedError
        );
        await expect(provider.textToSpeech({ input: { text: "hello", voice: "voice-1" } } as any, ctx)).rejects.toBeInstanceOf(
            CapabilityUnsupportedError
        );
        expect(() => provider.textToSpeechStream({ input: { text: "hello", voice: "voice-1" } } as any, ctx)).toThrow(
            CapabilityUnsupportedError
        );
    });
});
