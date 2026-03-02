import { beforeEach, describe, expect, it, vi } from "vitest";

const geminiConstructor = vi.hoisted(
    () =>
        vi.fn(function GeminiMock() {
            return { models: {} };
        })
);
vi.mock("@google/genai", () => ({ GoogleGenAI: geminiConstructor }));

beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("#root/index.js");
    vi.doUnmock("#root/providers/gemini/GeminiProvider.js");
});

const config = { apiKey: "k", apiKeyEnvVar: "GEMINI_API_KEY", providerDefaults: {} } as any;

describe("GeminiProvider", () => {
    it("throws when init is called without apiKey", async () => {
        const { GeminiProvider } = await import("#root/providers/gemini/GeminiProvider.js");
        const provider = new GeminiProvider();
        expect(() => provider.init({ apiKeyEnvVar: "GEMINI_API_KEY" } as any)).toThrow("Gemini API key");
    });

    it("initializes SDK client and registers capabilities", async () => {
        const { GeminiProvider } = await import("#root/providers/gemini/GeminiProvider.js");
        const { CapabilityKeys } = await import("#root/index.js");
        const provider = new GeminiProvider();
        provider.init(config);

        expect(geminiConstructor).toHaveBeenCalled();
        expect(provider.hasCapability(CapabilityKeys.ChatCapabilityKey)).toBe(true);
        expect(provider.hasCapability(CapabilityKeys.ChatStreamCapabilityKey)).toBe(true);
        expect(provider.hasCapability(CapabilityKeys.EmbedCapabilityKey)).toBe(true);
        expect(provider.hasCapability(CapabilityKeys.ModerationCapabilityKey)).toBe(true);
        expect(provider.hasCapability(CapabilityKeys.ImageGenerationCapabilityKey)).toBe(true);
        expect(provider.hasCapability(CapabilityKeys.ImageGenerationStreamCapabilityKey)).toBe(true);
        expect(provider.hasCapability(CapabilityKeys.ImageAnalysisCapabilityKey)).toBe(true);
        expect(provider.hasCapability(CapabilityKeys.ImageAnalysisStreamCapabilityKey)).toBe(true);
        expect(provider.hasCapability(CapabilityKeys.VideoAnalysisCapabilityKey)).toBe(true);
        expect(provider.hasCapability(CapabilityKeys.AudioTranscriptionCapabilityKey)).toBe(true);
        expect(provider.hasCapability(CapabilityKeys.AudioTranscriptionStreamCapabilityKey)).toBe(true);
        expect(provider.hasCapability(CapabilityKeys.AudioTranslationCapabilityKey)).toBe(true);
        expect(provider.hasCapability(CapabilityKeys.AudioTextToSpeechCapabilityKey)).toBe(true);
        expect(provider.hasCapability(CapabilityKeys.AudioTextToSpeechStreamCapabilityKey)).toBe(true);
        expect(provider.hasCapability(CapabilityKeys.VideoGenerationCapabilityKey)).toBe(true);
        expect(provider.hasCapability(CapabilityKeys.VideoExtendCapabilityKey)).toBe(true);
        expect(provider.hasCapability(CapabilityKeys.VideoDownloadCapabilityKey)).toBe(true);
    });

    it("forwards to delegates and throws when chat delegate missing", async () => {
        const { GeminiProvider } = await import("#root/providers/gemini/GeminiProvider.js");
        const { CapabilityUnsupportedError, MultiModalExecutionContext } = await import("#root/index.js");

        const provider = new GeminiProvider();
        const ctx = new MultiModalExecutionContext();

        (provider as any).chatDelegate = { chat: vi.fn().mockResolvedValue({ output: { role: "assistant", content: [] } }) };
        (provider as any).moderationDelegate = { moderation: vi.fn().mockResolvedValue({ output: [] }) };
        (provider as any).embedDelegate = { embed: vi.fn().mockResolvedValue({ output: [] }) };
        (provider as any).imageGenerationDelegate = {
            generateImage: vi.fn().mockResolvedValue({ output: [] }),
            generateImageStream: vi.fn().mockReturnValue((async function* () { yield { done: true }; })())
        };
        (provider as any).imageAnalysisDelegate = {
            analyzeImage: vi.fn().mockResolvedValue({ output: [] }),
            analyzeImageStream: vi.fn().mockReturnValue((async function* () { yield { done: true }; })())
        };
        (provider as any).audioDelegate = {
            transcribeAudio: vi.fn().mockResolvedValue({ output: [] }),
            transcribeAudioStream: vi.fn().mockReturnValue((async function* () { yield { done: true }; })()),
            translateAudio: vi.fn().mockResolvedValue({ output: [] }),
            textToSpeech: vi.fn().mockResolvedValue({ output: [] }),
            textToSpeechStream: vi.fn().mockReturnValue((async function* () { yield { done: true }; })())
        };
        (provider as any).videoGenerationDelegate = {
            generateVideo: vi.fn().mockResolvedValue({ output: [] })
        };
        (provider as any).videoAnalysisDelegate = {
            analyzeVideo: vi.fn().mockResolvedValue({ output: [] })
        };
        (provider as any).videoExtendDelegate = {
            extendVideo: vi.fn().mockResolvedValue({ output: [] })
        };
        (provider as any).videoDownloadDelegate = {
            downloadVideo: vi.fn().mockResolvedValue({ output: [] })
        };

        await expect(provider.chat({ input: { messages: [{ role: "user", content: [{ type: "text", text: "x" }] }] } } as any, ctx)).resolves.toHaveProperty(
            "output"
        );
        await expect(provider.moderation({ input: { input: "x" } } as any, ctx)).resolves.toMatchObject({ output: [] });
        await expect(provider.embed({ input: { input: "x" } } as any, ctx)).resolves.toMatchObject({ output: [] });
        await expect(provider.generateImage({ input: { prompt: "x" } } as any, ctx)).resolves.toMatchObject({ output: [] });
        await expect(provider.analyzeImage({ input: { images: [{ base64: "QQ==" }] } } as any, ctx)).resolves.toMatchObject({ output: [] });
        await expect(provider.transcribeAudio({ input: { file: {} } } as any, ctx)).resolves.toMatchObject({ output: [] });
        await expect(provider.translateAudio({ input: { file: {} } } as any, ctx)).resolves.toMatchObject({ output: [] });
        await expect(provider.textToSpeech({ input: { text: "x" } } as any, ctx)).resolves.toMatchObject({ output: [] });
        await expect(provider.generateVideo({ input: { prompt: "x" } } as any, ctx)).resolves.toMatchObject({ output: [] });
        await expect(
            provider.analyzeVideo({ input: { videos: [{ id: "v1", base64: "AQID", mimeType: "video/mp4" }] } } as any, ctx)
        ).resolves.toMatchObject({ output: [] });
        await expect(
            provider.extendVideo({ input: { sourceVideoUri: "gs://bucket/video.mp4", prompt: "x" } } as any, ctx)
        ).resolves.toMatchObject({ output: [] });
        await expect(provider.downloadVideo({ input: { videoUri: "https://example.com/video.mp4" } } as any, ctx)).resolves.toMatchObject({ output: [] });
        await expect(provider.generateImageStream({ input: { prompt: "x" } } as any, ctx).next()).resolves.toMatchObject({ done: false });
        await expect(provider.analyzeImageStream({ input: { images: [{ base64: "QQ==" }] } } as any, ctx).next()).resolves.toMatchObject({ done: false });
        await expect(provider.transcribeAudioStream({ input: { file: {} } } as any, ctx).next()).resolves.toMatchObject({ done: false });
        await expect(provider.textToSpeechStream({ input: { text: "x" } } as any, ctx).next()).resolves.toMatchObject({ done: false });

        (provider as any).chatDelegate = null;
        await expect(provider.chat({ input: { messages: [{ role: "user", content: [{ type: "text", text: "x" }] }] } } as any, ctx)).rejects.toBeInstanceOf(
            CapabilityUnsupportedError
        );
    });

    it("throws CapabilityUnsupportedError for each missing delegate method", async () => {
        const { GeminiProvider } = await import("#root/providers/gemini/GeminiProvider.js");
        const { CapabilityUnsupportedError, MultiModalExecutionContext } = await import("#root/index.js");

        const provider = new GeminiProvider();
        const ctx = new MultiModalExecutionContext();

        expect(() =>
            provider.chatStream({ input: { messages: [{ role: "user", content: [{ type: "text", text: "x" }] }] } } as any, ctx)
        ).toThrow(CapabilityUnsupportedError);
        await expect(provider.moderation({ input: { input: "x" } } as any, ctx)).rejects.toBeInstanceOf(CapabilityUnsupportedError);
        await expect(provider.embed({ input: { input: "x" } } as any, ctx)).rejects.toBeInstanceOf(CapabilityUnsupportedError);
        await expect(provider.generateImage({ input: { prompt: "x" } } as any, ctx)).rejects.toBeInstanceOf(CapabilityUnsupportedError);
        expect(() => provider.generateImageStream({ input: { prompt: "x" } } as any, ctx)).toThrow(CapabilityUnsupportedError);
        await expect(provider.analyzeImage({ input: { images: [{ base64: "QQ==" }] } } as any, ctx)).rejects.toBeInstanceOf(CapabilityUnsupportedError);
        expect(() => provider.analyzeImageStream({ input: { images: [{ base64: "QQ==" }] } } as any, ctx)).toThrow(CapabilityUnsupportedError);
        await expect(provider.transcribeAudio({ input: { file: {} } } as any, ctx)).rejects.toBeInstanceOf(CapabilityUnsupportedError);
        expect(() => provider.transcribeAudioStream({ input: { file: {} } } as any, ctx)).toThrow(CapabilityUnsupportedError);
        await expect(provider.translateAudio({ input: { file: {} } } as any, ctx)).rejects.toBeInstanceOf(CapabilityUnsupportedError);
        await expect(provider.textToSpeech({ input: { text: "x" } } as any, ctx)).rejects.toBeInstanceOf(CapabilityUnsupportedError);
        expect(() => provider.textToSpeechStream({ input: { text: "x" } } as any, ctx)).toThrow(CapabilityUnsupportedError);
        await expect(provider.generateVideo({ input: { prompt: "x" } } as any, ctx)).rejects.toBeInstanceOf(CapabilityUnsupportedError);
        await expect(
            provider.analyzeVideo({ input: { videos: [{ id: "v1", base64: "AQID", mimeType: "video/mp4" }] } } as any, ctx)
        ).rejects.toBeInstanceOf(CapabilityUnsupportedError);
        await expect(
            provider.extendVideo({ input: { sourceVideoUri: "gs://bucket/video.mp4", prompt: "x" } } as any, ctx)
        ).rejects.toBeInstanceOf(CapabilityUnsupportedError);
        await expect(provider.downloadVideo({ input: { videoUri: "https://example.com/video.mp4" } } as any, ctx)).rejects.toBeInstanceOf(
            CapabilityUnsupportedError
        );
    });
});
