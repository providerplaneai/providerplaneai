import { describe, expect, it, vi } from "vitest";
import { writeFile } from "node:fs/promises";
import { Readable } from "node:stream";
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
    it("translateAudio rejects when aborted before execution", async () => {
        const cap = new OpenAIAudioTranslationCapabilityImpl(makeProvider(), {} as any);
        const ac = new AbortController();
        ac.abort();
        await expect(cap.translateAudio({ input: { file: Buffer.from("abc") } } as any, {} as any, ac.signal)).rejects.toThrow(
            "Audio translation request aborted before execution"
        );
    });

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

    it("translateAudio accepts English variants and local file paths", async () => {
        const client = {
            audio: {
                translations: {
                    create: vi.fn().mockResolvedValue({ text: "ok" })
                }
            }
        } as any;

        const cap = new OpenAIAudioTranslationCapabilityImpl(makeProvider(), client);
        const localPath = `test_data/openai-translation-${Date.now()}.wav`;
        await writeFile(localPath, Buffer.from([1, 2, 3]));

        const res = await cap.translateAudio(
            { input: { file: localPath, targetLanguage: "en-us" }, context: { requestId: "req-en-us" } } as any,
            {} as any
        );

        expect(res.id).toBe("req-en-us");
        expect(client.audio.translations.create).toHaveBeenCalledTimes(1);
    });

    it("translateAudio rejects malformed data URL input", async () => {
        const client = { audio: { translations: { create: vi.fn() } } } as any;
        const cap = new OpenAIAudioTranslationCapabilityImpl(makeProvider(), client);
        await expect(
            cap.translateAudio({ input: { file: "data:audio/mpeg;base64", targetLanguage: "en" } } as any, {} as any)
        ).rejects.toThrow("Invalid data URL");
    });

    it("helper methods handle language aliases, data URL formats, and path fallbacks", () => {
        const cap = new OpenAIAudioTranslationCapabilityImpl(makeProvider(), {} as any);

        expect((cap as any).isEnglishTarget("en")).toBe(true);
        expect((cap as any).isEnglishTarget("eng")).toBe(true);
        expect((cap as any).isEnglishTarget("english")).toBe(true);
        expect((cap as any).isEnglishTarget("en-gb")).toBe(true);
        expect((cap as any).isEnglishTarget("de")).toBe(false);

        expect((cap as any).extractTranslationText("plain")).toBe("plain");
        expect((cap as any).extractTranslationText({ text: "value" })).toBe("value");
        expect((cap as any).extractTranslationText({})).toBe("");

        expect((cap as any).parseDataUrl("data:audio/mpeg;base64,AQID")).toEqual({
            bytes: Buffer.from([1, 2, 3]),
            mimeType: "audio/mpeg"
        });
        expect((cap as any).parseDataUrl("data:text/plain,hello%20world")).toEqual({
            bytes: Buffer.from("hello world", "utf8"),
            mimeType: "text/plain"
        });

        expect((cap as any).fileNameFromPath("/tmp/a.wav")).toBe("a.wav");
        expect((cap as any).fileNameFromPath("C:\\tmp\\a.wav")).toBe("a.wav");
        expect((cap as any).fileNameFromPath("")).toBe("audio-input");
    });

    it("toUploadableAudioFile handles typed arrays, array buffers, blob-like, data-url text, and streams", async () => {
        const cap = new OpenAIAudioTranslationCapabilityImpl(makeProvider(), {} as any);

        const fromUint8 = await (cap as any).toUploadableAudioFile(Uint8Array.from([1, 2]), "u8.raw", "audio/raw");
        expect(fromUint8).toBeTruthy();

        const fromArrayBuffer = await (cap as any).toUploadableAudioFile(
            Uint8Array.from([3, 4]).buffer,
            "ab.raw",
            "audio/raw"
        );
        expect(fromArrayBuffer).toBeTruthy();

        const blobLike = new Blob([Uint8Array.from([5, 6])], { type: "audio/wav" });
        const fromBlobLike = await (cap as any).toUploadableAudioFile(blobLike, "blob.wav");
        expect(fromBlobLike).toBeTruthy();

        const fromDataUrlText = await (cap as any).toUploadableAudioFile("data:,hello%20world", "text.dat");
        expect(fromDataUrlText).toBeTruthy();

        const fromStream = await (cap as any).toUploadableAudioFile(Readable.from([Buffer.from([7, 8])]), "s.bin");
        expect(fromStream).toBeTruthy();
    });

    it("isBlobLike and parseDataUrl fallback branches are handled", () => {
        const cap = new OpenAIAudioTranslationCapabilityImpl(makeProvider(), {} as any);
        expect((cap as any).isBlobLike(null)).toBe(false);
        expect((cap as any).isBlobLike({ arrayBuffer: async () => new ArrayBuffer(0), type: "audio/mpeg" })).toBe(true);

        expect((cap as any).parseDataUrl("data:;base64,AQID")).toEqual({
            bytes: Buffer.from([1, 2, 3]),
            mimeType: "application/octet-stream"
        });
    });
});
