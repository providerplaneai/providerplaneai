import { describe, expect, it, vi } from "vitest";
import { writeFile } from "node:fs/promises";
import { Readable } from "node:stream";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileNameFromPath, isBlobLike, parseDataUriToBuffer } from "#root/index.js";
import { OpenAIAudioTranslationCapabilityImpl } from "#root/providers/openai/capabilities/OpenAIAudioTranslationCapabilityImpl.js";
import { toOpenAIUploadableFile } from "#root/providers/openai/capabilities/shared/OpenAIFileUtils.js";

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

    it("translateAudio falls back to request id when provider omits response id", async () => {
        const client = {
            audio: {
                translations: {
                    create: vi.fn().mockResolvedValue({ text: "translated via fallback" })
                }
            }
        } as any;

        const cap = new OpenAIAudioTranslationCapabilityImpl(makeProvider(), client);
        const res = await cap.translateAudio(
            {
                input: { file: Buffer.from("abc"), targetLanguage: "en" },
                context: { requestId: "translation-fallback-id", metadata: { trace: "tr" } }
            } as any,
            {} as any
        );

        expect(res.id).toBe("translation-fallback-id");
        expect(res.output[0]?.id).toBe("translation-fallback-id");
        expect(res.output[0]?.metadata?.trace).toBe("tr");
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
        const localPath = path.join(tmpdir(), `openai-translation-${Date.now()}.wav`);
        await writeFile(localPath, Buffer.from([1, 2, 3]));

        const res = await cap.translateAudio(
            { input: { file: localPath, targetLanguage: "en-us" }, context: { requestId: "req-en-us" } } as any,
            {} as any
        );

        expect(res.id).toBe("req-en-us");
        expect(client.audio.translations.create).toHaveBeenCalledTimes(1);
    });

    it("translateAudio forwards optional params and merged provider overrides", async () => {
        const provider = makeProvider();
        provider.getMergedOptions = vi.fn().mockReturnValue({
            model: "gpt-4o-mini-transcribe",
            modelParams: { temperature: 0.4 },
            providerParams: { user: "u-9" },
            generalParams: {}
        });
        const create = vi.fn().mockResolvedValue({ text: "ok" });
        const cap = new OpenAIAudioTranslationCapabilityImpl(
            provider,
            { audio: { translations: { create } } } as any
        );

        await cap.translateAudio(
            {
                input: {
                    file: Buffer.from("abc"),
                    targetLanguage: "english",
                    prompt: "translate carefully",
                    responseFormat: "verbose_json",
                    temperature: 0.1
                }
            } as any,
            {} as any
        );

        expect(create).toHaveBeenCalledWith(
            expect.objectContaining({
                model: "gpt-4o-mini-transcribe",
                prompt: "translate carefully",
                response_format: "verbose_json",
                temperature: 0.4,
                user: "u-9"
            }),
            expect.any(Object)
        );
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

        expect(parseDataUriToBuffer("data:audio/mpeg;base64,AQID")).toEqual({
            bytes: Buffer.from([1, 2, 3]),
            mimeType: "audio/mpeg"
        });
        expect(parseDataUriToBuffer("data:text/plain,hello%20world")).toEqual({
            bytes: Buffer.from("hello world", "utf8"),
            mimeType: "text/plain"
        });

        expect(fileNameFromPath("/tmp/a.wav", "audio-input")).toBe("a.wav");
        expect(fileNameFromPath("C:\\tmp\\a.wav", "audio-input")).toBe("a.wav");
        expect(fileNameFromPath("", "audio-input")).toBe("audio-input");
    });

    it("shared upload helper handles typed arrays, array buffers, blob-like, data-url text, and streams", async () => {
        const fromUint8 = await toOpenAIUploadableFile(Uint8Array.from([1, 2]), "u8.raw", "audio/raw", "audio-input");
        expect(fromUint8).toBeTruthy();

        const fromArrayBuffer = await toOpenAIUploadableFile(
            Uint8Array.from([3, 4]).buffer,
            "ab.raw",
            "audio/raw",
            "audio-input"
        );
        expect(fromArrayBuffer).toBeTruthy();

        const blobLike = new Blob([Uint8Array.from([5, 6])], { type: "audio/wav" });
        const fromBlobLike = await toOpenAIUploadableFile(blobLike, "blob.wav", undefined, "audio-input");
        expect(fromBlobLike).toBeTruthy();

        const fromDataUrlText = await toOpenAIUploadableFile("data:,hello%20world", "text.dat", undefined, "audio-input");
        expect(fromDataUrlText).toBeTruthy();

        const fromStream = await toOpenAIUploadableFile(Readable.from([Buffer.from([7, 8])]), "s.bin", undefined, "audio-input");
        expect(fromStream).toBeTruthy();
    });

    it("isBlobLike and shared Data URI buffer fallback branches are handled", () => {
        const cap = new OpenAIAudioTranslationCapabilityImpl(makeProvider(), {} as any);
        expect(isBlobLike(null)).toBe(false);
        expect(isBlobLike({ arrayBuffer: async () => new ArrayBuffer(0), type: "audio/mpeg" })).toBe(true);

        expect(parseDataUriToBuffer("data:;base64,AQID")).toEqual({
            bytes: Buffer.from([1, 2, 3]),
            mimeType: "application/octet-stream"
        });
    });
});
