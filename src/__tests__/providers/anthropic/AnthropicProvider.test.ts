import { beforeEach, describe, expect, it, vi } from "vitest";

const anthropicConstructor = vi.hoisted(
    () =>
        vi.fn(function AnthropicMock() {
            return { messages: {} };
        })
);
vi.mock("@anthropic-ai/sdk", () => ({ default: anthropicConstructor }));

beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("#root/index.js");
    vi.doUnmock("#root/providers/anthropic/AnthropicProvider.js");
});

const config = { apiKey: "k", apiKeyEnvVar: "ANTHROPIC_API_KEY", providerDefaults: {} } as any;

describe("AnthropicProvider", () => {
    it("throws when init is called without apiKey", async () => {
        const { AnthropicProvider } = await import("#root/providers/anthropic/AnthropicProvider.js");
        const provider = new AnthropicProvider();
        expect(() => provider.init({ apiKeyEnvVar: "ANTHROPIC_API_KEY" } as any)).toThrow("Anthropic API key");
    }, 15000);

    it("initializes SDK client and registers capabilities", async () => {
        process.env.VOYAGE_API_KEY = "voyage-test";
        const { AnthropicProvider } = await import("#root/providers/anthropic/AnthropicProvider.js");
        const { CapabilityKeys } = await import("#root/index.js");

        const provider = new AnthropicProvider();
        provider.init(config);

        expect(anthropicConstructor).toHaveBeenCalled();
        expect(provider.hasCapability(CapabilityKeys.ChatCapabilityKey)).toBe(true);
        expect(provider.hasCapability(CapabilityKeys.ChatStreamCapabilityKey)).toBe(true);
        expect(provider.hasCapability(CapabilityKeys.EmbedCapabilityKey)).toBe(true);
        expect(provider.hasCapability(CapabilityKeys.ModerationCapabilityKey)).toBe(true);
        expect(provider.hasCapability(CapabilityKeys.ImageAnalysisCapabilityKey)).toBe(true);
        expect(provider.hasCapability(CapabilityKeys.ImageAnalysisStreamCapabilityKey)).toBe(true);
        expect(provider.hasCapability(CapabilityKeys.OCRCapabilityKey)).toBe(true);
    });

    it("forwards to delegates and throws when chat delegate missing", async () => {
        const { AnthropicProvider } = await import("#root/providers/anthropic/AnthropicProvider.js");
        const { CapabilityUnsupportedError, MultiModalExecutionContext } = await import("#root/index.js");

        const provider = new AnthropicProvider();
        const ctx = new MultiModalExecutionContext();

        (provider as any).chatDelegate = { chat: vi.fn().mockResolvedValue({ output: { role: "assistant", content: [] } }) };
        (provider as any).moderateDelegate = { moderation: vi.fn().mockResolvedValue({ output: [] }) };
        (provider as any).embedDelegate = { embed: vi.fn().mockResolvedValue({ output: [] }) };
        (provider as any).imageAnalysisDelegate = {
            analyzeImage: vi.fn().mockResolvedValue({ output: [] }),
            analyzeImageStream: vi.fn().mockReturnValue((async function* () { yield { done: true }; })())
        };
        (provider as any).ocrDelegate = { ocr: vi.fn().mockResolvedValue({ output: [] }) };

        await expect(provider.chat({ input: { messages: [{ role: "user", content: [{ type: "text", text: "x" }] }] } } as any, ctx)).resolves.toHaveProperty(
            "output"
        );
        await expect(provider.moderation({ input: { input: "x" } } as any, ctx)).resolves.toMatchObject({ output: [] });
        await expect(provider.embed({ input: { input: "x" } } as any, ctx)).resolves.toMatchObject({ output: [] });
        await expect(provider.analyzeImage({ input: { images: [{ base64: "QQ==" }] } } as any, ctx)).resolves.toMatchObject({ output: [] });
        await expect(provider.analyzeImageStream({ input: { images: [{ base64: "QQ==" }] } } as any, ctx).next()).resolves.toMatchObject({ done: false });
        await expect(provider.ocr({ input: { file: "https://example.com/doc.png", mimeType: "image/png" } } as any, ctx)).resolves.toMatchObject({ output: [] });

        (provider as any).chatDelegate = null;
        await expect(provider.chat({ input: { messages: [{ role: "user", content: [{ type: "text", text: "x" }] }] } } as any, ctx)).rejects.toBeInstanceOf(
            CapabilityUnsupportedError
        );
    });

    it("throws CapabilityUnsupportedError for each missing delegate method", async () => {
        const { AnthropicProvider } = await import("#root/providers/anthropic/AnthropicProvider.js");
        const { CapabilityUnsupportedError, MultiModalExecutionContext } = await import("#root/index.js");

        const provider = new AnthropicProvider();
        const ctx = new MultiModalExecutionContext();

        expect(() =>
            provider.chatStream({ input: { messages: [{ role: "user", content: [{ type: "text", text: "x" }] }] } } as any, ctx)
        ).toThrow(CapabilityUnsupportedError);
        await expect(provider.moderation({ input: { input: "x" } } as any, ctx)).rejects.toBeInstanceOf(CapabilityUnsupportedError);
        await expect(provider.embed({ input: { input: "x" } } as any, ctx)).rejects.toBeInstanceOf(CapabilityUnsupportedError);
        await expect(provider.analyzeImage({ input: { images: [{ base64: "QQ==" }] } } as any, ctx)).rejects.toBeInstanceOf(CapabilityUnsupportedError);
        expect(() => provider.analyzeImageStream({ input: { images: [{ base64: "QQ==" }] } } as any, ctx)).toThrow(CapabilityUnsupportedError);
        await expect(provider.ocr({ input: { file: "https://example.com/doc.png", mimeType: "image/png" } } as any, ctx)).rejects.toBeInstanceOf(CapabilityUnsupportedError);
    });
});
