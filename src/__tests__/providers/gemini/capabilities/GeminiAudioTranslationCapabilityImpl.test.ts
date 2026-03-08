import { describe, expect, it, vi } from "vitest";
import { GeminiAudioTranslationCapabilityImpl } from "#root/providers/gemini/capabilities/GeminiAudioTranslationCapabilityImpl.js";

function makeProvider() {
    return {
        ensureInitialized: vi.fn(),
        getMergedOptions: vi.fn((_capability: string, runtimeOptions: any) => ({
            model: runtimeOptions?.model,
            modelParams: {},
            providerParams: {},
            generalParams: runtimeOptions?.generalParams ?? {}
        }))
    } as any;
}

describe("GeminiAudioTranslationCapabilityImpl", () => {
    it("translateAudio validates required file input", async () => {
        const cap = new GeminiAudioTranslationCapabilityImpl(makeProvider(), {} as any);
        await expect(cap.translateAudio({ input: {} } as any, {} as any)).rejects.toThrow(
            "Audio translation requires a non-empty 'file' input"
        );
    });

    it("translateAudio rejects malformed string input", async () => {
        const client = { models: { generateContent: vi.fn() } } as any;
        const cap = new GeminiAudioTranslationCapabilityImpl(makeProvider(), client);

        await expect(
            cap.translateAudio(
                { input: { file: "invalid-input", targetLanguage: "en" } } as any,
                {} as any
            )
        ).rejects.toThrow("String audio input must be a data URL or local file path");
    });

    it("translateAudio maps response and usage metadata", async () => {
        const generateContent = vi.fn().mockResolvedValue({
            text: "hola => hello",
            responseId: "g-tr-1",
            usageMetadata: {
                promptTokenCount: 5,
                candidatesTokenCount: 3,
                totalTokenCount: 8
            }
        });

        const client = { models: { generateContent } } as any;
        const cap = new GeminiAudioTranslationCapabilityImpl(makeProvider(), client);

        const res = await cap.translateAudio(
            {
                input: {
                    file: Buffer.from("abc"),
                    targetLanguage: "en",
                    responseFormat: "text",
                    prompt: "keep punctuation"
                },
                context: { requestId: "ctx-tr-1" }
            } as any,
            {} as any
        );

        expect(res.id).toBe("g-tr-1");
        expect(res.output[0]?.content?.[0]).toEqual({ type: "text", text: "hola => hello" });
        expect(res.metadata?.provider).toBe("gemini");
        expect(res.metadata?.totalTokens).toBe(8);

        const arg = generateContent.mock.calls[0]?.[0];
        const instruction = arg?.contents?.[0]?.parts?.[0]?.text;
        expect(typeof instruction).toBe("string");
        expect(instruction).toContain("Translate the provided audio into en");
        expect(instruction).toContain("Additional style guidance: keep punctuation");
    });

    it("translateAudio handles response without text", async () => {
        const client = {
            models: {
                generateContent: vi.fn().mockResolvedValue({ responseId: "g-tr-2" })
            }
        } as any;

        const cap = new GeminiAudioTranslationCapabilityImpl(makeProvider(), client);
        const res = await cap.translateAudio(
            { input: { file: Buffer.from("abc"), targetLanguage: "english" } } as any,
            {} as any
        );

        expect(res.output[0]?.content).toEqual([]);
        expect(res.metadata?.provider).toBe("gemini");
    });
});
