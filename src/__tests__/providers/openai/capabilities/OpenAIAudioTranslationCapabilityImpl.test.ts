import { describe, expect, it, vi } from "vitest";
import { OpenAIAudioTranslationCapabilityImpl } from "#root/providers/openai/capabilities/OpenAIAudioTranslationCapabilityImpl.js";

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

describe("OpenAIAudioTranslationCapabilityImpl", () => {
    it("translateAudio validates required file input", async () => {
        const cap = new OpenAIAudioTranslationCapabilityImpl(makeProvider(), {} as any);
        await expect(cap.translateAudio({ input: {} } as any, {} as any)).rejects.toThrow(
            "Audio translation requires a non-empty 'file' input"
        );
    });

    it("translateAudio rejects non-English target language", async () => {
        const cap = new OpenAIAudioTranslationCapabilityImpl(makeProvider(), {} as any);
        await expect(
            cap.translateAudio(
                { input: { file: Buffer.from("abc"), targetLanguage: "de" } } as any,
                {} as any
            )
        ).rejects.toThrow("OpenAI audio translation supports English output only");
    });

    it("translateAudio rejects malformed string input", async () => {
        const client = { audio: { translations: { create: vi.fn() } } } as any;
        const cap = new OpenAIAudioTranslationCapabilityImpl(makeProvider(), client);
        await expect(
            cap.translateAudio(
                { input: { file: "not-a-data-url-or-local-file", targetLanguage: "en" } } as any,
                {} as any
            )
        ).rejects.toThrow("String audio input must be a data URL or local file path");
    });

    it("translateAudio maps object response text", async () => {
        const client = {
            audio: {
                translations: {
                    create: vi.fn().mockResolvedValue({ id: "tr-1", text: "translated text" })
                }
            }
        } as any;

        const cap = new OpenAIAudioTranslationCapabilityImpl(makeProvider(), client);
        const res = await cap.translateAudio(
            {
                input: { file: Buffer.from("abc"), targetLanguage: "en", responseFormat: "json" },
                context: { requestId: "ctx-1" }
            } as any,
            {} as any
        );

        expect(res.id).toBe("tr-1");
        expect(res.output[0]?.content?.[0]).toEqual({ type: "text", text: "translated text" });
        expect(res.metadata?.provider).toBe("openai");
    });

    it("translateAudio maps plain string response", async () => {
        const client = {
            audio: {
                translations: {
                    create: vi.fn().mockResolvedValue("translated plain text")
                }
            }
        } as any;

        const cap = new OpenAIAudioTranslationCapabilityImpl(makeProvider(), client);
        const res = await cap.translateAudio(
            { input: { file: Buffer.from("abc"), targetLanguage: "english" } } as any,
            {} as any
        );

        expect(res.output[0]?.content?.[0]).toEqual({ type: "text", text: "translated plain text" });
    });
});
