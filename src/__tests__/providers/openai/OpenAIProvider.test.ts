import { beforeEach, describe, expect, it, vi } from "vitest";

const openAIConstructor = vi.hoisted(
    () =>
        vi.fn(function OpenAIMock() {
            return { responses: {}, embeddings: {}, moderations: {}, audio: {}, videos: {} };
        })
);
vi.mock("openai", () => ({ default: openAIConstructor }));

beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("#root/index.js");
    vi.doUnmock("#root/providers/openai/OpenAIProvider.js");
});

const config = { apiKey: "k", apiKeyEnvVar: "OPENAI_API_KEY", providerDefaults: {} } as any;

describe("OpenAIProvider", () => {
    it("throws when init is called without apiKey", async () => {
        const { OpenAIProvider } = await import("#root/providers/openai/OpenAIProvider.js");
        const provider = new OpenAIProvider();
        expect(() => provider.init({ apiKeyEnvVar: "OPENAI_API_KEY" } as any)).toThrow("OpenAI API key");
    });

    it("initializes SDK client and registers capabilities", async () => {
        const { OpenAIProvider } = await import("#root/providers/openai/OpenAIProvider.js");
        const { CapabilityKeys } = await import("#root/index.js");

        const provider = new OpenAIProvider();
        provider.init(config);

        expect(openAIConstructor).toHaveBeenCalled();
        expect(provider.hasCapability(CapabilityKeys.ChatCapabilityKey)).toBe(true);
        expect(provider.hasCapability(CapabilityKeys.ChatStreamCapabilityKey)).toBe(true);
        expect(provider.hasCapability(CapabilityKeys.EmbedCapabilityKey)).toBe(true);
        expect(provider.hasCapability(CapabilityKeys.ModerationCapabilityKey)).toBe(true);
        expect(provider.hasCapability(CapabilityKeys.ImageGenerationCapabilityKey)).toBe(true);
        expect(provider.hasCapability(CapabilityKeys.ImageGenerationStreamCapabilityKey)).toBe(true);
        expect(provider.hasCapability(CapabilityKeys.ImageEditCapabilityKey)).toBe(true);
        expect(provider.hasCapability(CapabilityKeys.ImageEditStreamCapabilityKey)).toBe(true);
        expect(provider.hasCapability(CapabilityKeys.ImageAnalysisCapabilityKey)).toBe(true);
        expect(provider.hasCapability(CapabilityKeys.ImageAnalysisStreamCapabilityKey)).toBe(true);
        expect(provider.hasCapability(CapabilityKeys.AudioTranscriptionCapabilityKey)).toBe(true);
        expect(provider.hasCapability(CapabilityKeys.AudioTranscriptionStreamCapabilityKey)).toBe(true);
        expect(provider.hasCapability(CapabilityKeys.AudioTranslationCapabilityKey)).toBe(true);
        expect(provider.hasCapability(CapabilityKeys.AudioTextToSpeechCapabilityKey)).toBe(true);
        expect(provider.hasCapability(CapabilityKeys.AudioTextToSpeechStreamCapabilityKey)).toBe(true);
        expect(provider.hasCapability(CapabilityKeys.VideoGenerationCapabilityKey)).toBe(true);
        expect(provider.hasCapability(CapabilityKeys.VideoDownloadCapabilityKey)).toBe(true);
        expect(provider.hasCapability(CapabilityKeys.VideoRemixCapabilityKey)).toBe(true);
    });

    it("forwards to chat delegate and throws when missing", async () => {
        const { OpenAIProvider } = await import("#root/providers/openai/OpenAIProvider.js");
        const { CapabilityUnsupportedError, MultiModalExecutionContext } = await import("#root/index.js");

        const provider = new OpenAIProvider();
        const ctx = new MultiModalExecutionContext();
        const req = { input: { messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] } } as any;

        (provider as any).chatDelegate = { chat: vi.fn().mockResolvedValue({ output: { role: "assistant", content: [] } }) };
        await expect(provider.chat(req, ctx)).resolves.toMatchObject({ output: { role: "assistant" } });

        (provider as any).chatDelegate = null;
        await expect(provider.chat(req, ctx)).rejects.toBeInstanceOf(CapabilityUnsupportedError);
    });

    it("forwards non-chat capabilities to delegates", async () => {
        const { OpenAIProvider } = await import("#root/providers/openai/OpenAIProvider.js");
        const { MultiModalExecutionContext } = await import("#root/index.js");

        const provider = new OpenAIProvider();
        const ctx = new MultiModalExecutionContext();

        (provider as any).embedDelegate = { embed: vi.fn().mockResolvedValue({ output: [] }) };
        (provider as any).moderateDelegate = { moderation: vi.fn().mockResolvedValue({ output: [] }) };
        (provider as any).imageGenDelegate = {
            generateImage: vi.fn().mockResolvedValue({ output: [] }),
            generateImageStream: vi.fn().mockReturnValue((async function* () { yield { done: true }; })())
        };
        (provider as any).imageEditDelegate = {
            editImage: vi.fn().mockResolvedValue({ output: [] }),
            editImageStream: vi.fn().mockReturnValue((async function* () { yield { done: true }; })())
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
        (provider as any).videoDelegate = {
            generateVideo: vi.fn().mockResolvedValue({ output: [] })
        };
        (provider as any).videoDownloadDelegate = {
            downloadVideo: vi.fn().mockResolvedValue({ output: [] })
        };
        (provider as any).videoRemixDelegate = {
            remixVideo: vi.fn().mockResolvedValue({ output: [] })
        };

        await expect(provider.embed({ input: { input: "x" } } as any, ctx)).resolves.toMatchObject({ output: [] });
        await expect(provider.moderation({ input: { input: "x" } } as any, ctx)).resolves.toMatchObject({ output: [] });
        await expect(provider.generateImage({ input: { prompt: "x" } } as any, ctx)).resolves.toMatchObject({ output: [] });
        await expect(provider.editImage({ input: { prompt: "x" } } as any, ctx)).resolves.toMatchObject({ output: [] });
        await expect(provider.analyzeImage({ input: { images: [{ base64: "QQ==" }] } } as any, ctx)).resolves.toMatchObject({ output: [] });
        await expect(provider.transcribeAudio({ input: { file: {} } } as any, ctx)).resolves.toMatchObject({ output: [] });
        await expect(provider.translateAudio({ input: { file: {} } } as any, ctx)).resolves.toMatchObject({ output: [] });
        await expect(provider.textToSpeech({ input: { text: "hello" } } as any, ctx)).resolves.toMatchObject({ output: [] });
        await expect(provider.generateVideo({ input: { prompt: "video please" } } as any, ctx)).resolves.toMatchObject({
            output: []
        });
        await expect(provider.downloadVideo({ input: { videoId: "vid_1" } } as any, ctx)).resolves.toMatchObject({
            output: []
        });
        await expect(
            provider.remixVideo({ input: { sourceVideoId: "vid_1", prompt: "video please" } } as any, ctx)
        ).resolves.toMatchObject({ output: [] });
        await expect(provider.transcribeAudioStream({ input: { file: {} } } as any, ctx).next()).resolves.toMatchObject({
            done: false
        });
        await expect(provider.textToSpeechStream({ input: { text: "hello" } } as any, ctx).next()).resolves.toMatchObject({
            done: false
        });

        await expect(provider.generateImageStream({ input: { prompt: "x" } } as any, ctx).next()).resolves.toMatchObject({ done: false });
        await expect(provider.editImageStream({ input: { prompt: "x" } } as any, ctx).next()).resolves.toMatchObject({ done: false });
        await expect(provider.analyzeImageStream({ input: { images: [{ base64: "QQ==" }] } } as any, ctx).next()).resolves.toMatchObject({ done: false });
    });

    it("throws CapabilityUnsupportedError for each missing delegate method", async () => {
        const { OpenAIProvider } = await import("#root/providers/openai/OpenAIProvider.js");
        const { CapabilityUnsupportedError, MultiModalExecutionContext } = await import("#root/index.js");

        const provider = new OpenAIProvider();
        const ctx = new MultiModalExecutionContext();

        expect(() =>
            provider.chatStream({ input: { messages: [{ role: "user", content: [{ type: "text", text: "x" }] }] } } as any, ctx)
        ).toThrow(CapabilityUnsupportedError);
        await expect(provider.embed({ input: { input: "x" } } as any, ctx)).rejects.toBeInstanceOf(CapabilityUnsupportedError);
        await expect(provider.moderation({ input: { input: "x" } } as any, ctx)).rejects.toBeInstanceOf(CapabilityUnsupportedError);
        await expect(provider.generateImage({ input: { prompt: "x" } } as any, ctx)).rejects.toBeInstanceOf(CapabilityUnsupportedError);
        expect(() => provider.generateImageStream({ input: { prompt: "x" } } as any, ctx)).toThrow(CapabilityUnsupportedError);
        await expect(provider.editImage({ input: { prompt: "x" } } as any, ctx)).rejects.toBeInstanceOf(CapabilityUnsupportedError);
        expect(() => provider.editImageStream({ input: { prompt: "x" } } as any, ctx)).toThrow(CapabilityUnsupportedError);
        await expect(provider.analyzeImage({ input: { images: [{ base64: "QQ==" }] } } as any, ctx)).rejects.toBeInstanceOf(CapabilityUnsupportedError);
        expect(() => provider.analyzeImageStream({ input: { images: [{ base64: "QQ==" }] } } as any, ctx)).toThrow(CapabilityUnsupportedError);
        await expect(provider.transcribeAudio({ input: { file: {} } } as any, ctx)).rejects.toBeInstanceOf(CapabilityUnsupportedError);
        expect(() => provider.transcribeAudioStream({ input: { file: {} } } as any, ctx)).toThrow(CapabilityUnsupportedError);
        await expect(provider.translateAudio({ input: { file: {} } } as any, ctx)).rejects.toBeInstanceOf(CapabilityUnsupportedError);
        await expect(provider.textToSpeech({ input: { text: "x" } } as any, ctx)).rejects.toBeInstanceOf(CapabilityUnsupportedError);
        expect(() => provider.textToSpeechStream({ input: { text: "x" } } as any, ctx)).toThrow(CapabilityUnsupportedError);
        await expect(provider.generateVideo({ input: { prompt: "video please" } } as any, ctx)).rejects.toBeInstanceOf(
            CapabilityUnsupportedError
        );
        await expect(provider.downloadVideo({ input: { videoId: "vid_1" } } as any, ctx)).rejects.toBeInstanceOf(
            CapabilityUnsupportedError
        );
        await expect(
            provider.remixVideo({ input: { sourceVideoId: "vid_1", prompt: "video please" } } as any, ctx)
        ).rejects.toBeInstanceOf(CapabilityUnsupportedError);
    });
});
