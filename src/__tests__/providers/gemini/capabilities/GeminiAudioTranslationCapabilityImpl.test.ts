import { describe, expect, it, vi } from "vitest";
import { writeFile } from "node:fs/promises";
import { Readable } from "node:stream";
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
    it("translateAudio rejects when aborted before execution", async () => {
        const cap = new GeminiAudioTranslationCapabilityImpl(makeProvider(), {} as any);
        const ac = new AbortController();
        ac.abort();
        await expect(cap.translateAudio({ input: { file: Buffer.from("abc") } } as any, {} as any, ac.signal)).rejects.toThrow(
            "Audio translation request aborted before execution"
        );
    });

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

    it("translateAudio uses context requestId fallback and default target language when responseId/targetLanguage are absent", async () => {
        const generateContent = vi.fn().mockResolvedValue({
            text: "translated without response id"
        });
        const cap = new GeminiAudioTranslationCapabilityImpl(makeProvider(), { models: { generateContent } } as any);

        const res = await cap.translateAudio(
            {
                input: { file: Buffer.from("abc") },
                context: { requestId: "ctx-fallback-id" }
            } as any,
            {} as any
        );

        expect(res.id).toBe("ctx-fallback-id");
        expect(res.metadata?.targetLanguage).toBe("english");
        expect(res.output[0]?.metadata?.targetLanguage).toBe("english");
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

    it("translateAudio accepts blob-like, typed array, and array buffer sources", async () => {
        const generateContent = vi.fn().mockResolvedValue({ text: "ok", responseId: "g-tr-blob" });
        const client = { models: { generateContent } } as any;
        const cap = new GeminiAudioTranslationCapabilityImpl(makeProvider(), client);

        const blobLike = {
            type: "audio/wav",
            arrayBuffer: async () => Uint8Array.from([1, 2, 3]).buffer
        };
        await cap.translateAudio({ input: { file: blobLike as any, targetLanguage: "en" } } as any, {} as any);
        await cap.translateAudio({ input: { file: new Uint8Array([1, 2, 3]), targetLanguage: "en" } } as any, {} as any);
        await cap.translateAudio({ input: { file: Uint8Array.from([1, 2, 3]).buffer, targetLanguage: "en" } } as any, {} as any);

        expect(generateContent).toHaveBeenCalledTimes(3);
    });

    it("translateAudio supports data URLs and node readable streams", async () => {
        const generateContent = vi.fn().mockResolvedValue({ text: "ok", responseId: "g-tr-stream" });
        const client = { models: { generateContent } } as any;
        const cap = new GeminiAudioTranslationCapabilityImpl(makeProvider(), client);

        await cap.translateAudio(
            { input: { file: "data:audio/mpeg;base64,AQID", targetLanguage: "en" } } as any,
            {} as any
        );

        await cap.translateAudio(
            { input: { file: "data:text/plain,hello world", targetLanguage: "en" } } as any,
            {} as any
        );

        const stream = Readable.from([Buffer.from([1, 2]), Buffer.from([3])]);
        await cap.translateAudio({ input: { file: stream as any, targetLanguage: "en" } } as any, {} as any);

        expect(generateContent).toHaveBeenCalledTimes(3);
    });

    it("translateAudio handles stream string chunks and data-url mime fallback", async () => {
        const generateContent = vi.fn().mockResolvedValue({ text: "ok", responseId: "g-tr-stream-str" });
        const cap = new GeminiAudioTranslationCapabilityImpl(makeProvider(), { models: { generateContent } } as any);

        const stream = Readable.from(["a", "b", "c"]);
        await cap.translateAudio({ input: { file: stream as any, targetLanguage: "en" } } as any, {} as any);

        await cap.translateAudio({ input: { file: "data:;base64,AQID", targetLanguage: "en" } } as any, {} as any);
        const secondCallInline = generateContent.mock.calls[1]?.[0]?.contents?.[0]?.parts?.[1]?.inlineData;
        expect(secondCallInline?.mimeType).toBe("application/octet-stream");
    });

    it("translateAudio supports local file paths and infers mime from extension", async () => {
        const generateContent = vi.fn().mockResolvedValue({ text: "ok", responseId: "g-tr-file" });
        const client = { models: { generateContent } } as any;
        const cap = new GeminiAudioTranslationCapabilityImpl(makeProvider(), client);

        const wavPath = `test_data/gemini-translation-${Date.now()}.wav`;
        await writeFile(wavPath, Buffer.from([1, 2, 3]));

        await cap.translateAudio({ input: { file: wavPath, targetLanguage: "en" } } as any, {} as any);

        const arg = generateContent.mock.calls[0]?.[0];
        const inline = arg?.contents?.[0]?.parts?.[1]?.inlineData;
        expect(inline?.mimeType).toBe("audio/wav");
    });

    it("translateAudio throws for malformed data URL and unsupported source object", async () => {
        const generateContent = vi.fn().mockResolvedValue({ text: "ok", responseId: "g-tr-err" });
        const client = { models: { generateContent } } as any;
        const cap = new GeminiAudioTranslationCapabilityImpl(makeProvider(), client);

        await expect(
            cap.translateAudio({ input: { file: "data:audio/mpeg;base64", targetLanguage: "en" } } as any, {} as any)
        ).rejects.toThrow("Invalid data URL");

        await expect(
            cap.translateAudio({ input: { file: { foo: "bar" } as any, targetLanguage: "en" } } as any, {} as any)
        ).rejects.toThrow("Unsupported audio input source for Gemini translation");
    });

    it("inferMimeFromPath maps known extensions and default fallback", () => {
        const cap = new GeminiAudioTranslationCapabilityImpl(makeProvider(), {} as any);
        const infer = (p: string) => (cap as any).inferMimeFromPath(p);

        expect(infer("a.wav")).toBe("audio/wav");
        expect(infer("a.flac")).toBe("audio/flac");
        expect(infer("a.m4a")).toBe("audio/mp4");
        expect(infer("a.ogg")).toBe("audio/ogg");
        expect(infer("a.oga")).toBe("audio/ogg");
        expect(infer("a.opus")).toBe("audio/opus");
        expect(infer("a.aac")).toBe("audio/aac");
        expect(infer("a.webm")).toBe("audio/webm");
        expect(infer("a.mp3")).toBe("audio/mpeg");
    });

    it("helper methods cover instruction variants and blob mime fallback chain", async () => {
        const cap = new GeminiAudioTranslationCapabilityImpl(makeProvider(), {} as any);

        expect((cap as any).buildTranslationInstruction("  ", undefined, undefined)).toContain(
            "Translate the provided audio into English."
        );
        expect((cap as any).buildTranslationInstruction("fr", undefined, "srt")).toContain(
            "Return the translated output as srt."
        );
        expect((cap as any).buildTranslationInstruction("fr", "  ", "json")).toContain(
            "Return only the translated text."
        );

        const payloadWithBlobType = await (cap as any).resolveAudioPayload(
            { type: "audio/wav", arrayBuffer: async () => Uint8Array.from([1, 2]).buffer },
            undefined
        );
        expect(payloadWithBlobType.mimeType).toBe("audio/wav");

        const payloadWithDefaultType = await (cap as any).resolveAudioPayload(
            { type: "", arrayBuffer: async () => Uint8Array.from([1, 2]).buffer },
            undefined
        );
        expect(payloadWithDefaultType.mimeType).toBe("audio/mpeg");
    });
});
