import { beforeEach, describe, expect, it, vi } from "vitest";

const mistralConstructor = vi.hoisted(
    () =>
        vi.fn(function MistralMock() {
            return {
                chat: {},
                embeddings: {},
                classifiers: {},
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
        expect(provider.hasCapability(CapabilityKeys.AudioTranscriptionCapabilityKey)).toBe(true);
        expect(provider.hasCapability(CapabilityKeys.AudioTranscriptionStreamCapabilityKey)).toBe(true);
        expect(provider.hasCapability(CapabilityKeys.AudioTextToSpeechCapabilityKey)).toBe(true);
        expect(provider.hasCapability(CapabilityKeys.AudioTextToSpeechStreamCapabilityKey)).toBe(true);
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
});
