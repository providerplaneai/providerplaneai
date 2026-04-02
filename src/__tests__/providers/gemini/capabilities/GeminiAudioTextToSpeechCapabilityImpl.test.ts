import { describe, expect, it, vi } from "vitest";
import { GeminiAudioTextToSpeechCapabilityImpl } from "#root/providers/gemini/capabilities/GeminiAudioTextToSpeechCapabilityImpl.js";

function makeProvider(batchSize: number = 4) {
    return {
        ensureInitialized: vi.fn(),
        getMergedOptions: vi.fn((_capability: string, runtimeOptions: any) => ({
            model: runtimeOptions?.model,
            modelParams: {},
            providerParams: {},
            generalParams: {
                audioStreamBatchSize: batchSize,
                ...(runtimeOptions?.generalParams ?? {})
            }
        }))
    } as any;
}

async function collect<T>(iter: AsyncGenerator<T>): Promise<T[]> {
    const out: T[] = [];
    for await (const item of iter) {
        out.push(item);
    }
    return out;
}

describe("GeminiAudioTextToSpeechCapabilityImpl", () => {
    it("textToSpeech uses response.data fallback and context requestId", async () => {
        const provider = makeProvider();
        provider.getMergedOptions = vi.fn().mockReturnValue({
            model: "models/custom-tts",
            modelParams: { voice: "preset-voice" },
            providerParams: {},
            generalParams: {}
        });

        const generateContent = vi.fn().mockResolvedValue({
            data: "AQID"
        });
        const cap = new GeminiAudioTextToSpeechCapabilityImpl(provider, { models: { generateContent } } as any);
        const res = await cap.textToSpeech(
            {
                input: { text: "hello", instructions: "Speak warmly" },
                context: { requestId: "ctx-tts-1" }
            } as any,
            {} as any
        );

        expect(res.id).toBe("ctx-tts-1");
        const bytes = Buffer.from(res.output[0]?.base64 ?? "", "base64");
        expect(bytes.subarray(0, 4).toString("ascii")).toBe("RIFF");
        expect(bytes.subarray(8, 12).toString("ascii")).toBe("WAVE");
        expect(generateContent).toHaveBeenCalledWith(
            expect.objectContaining({
                model: "custom-tts",
                config: expect.objectContaining({
                    speechConfig: "preset-voice",
                    systemInstruction: "Speak warmly"
                })
            })
        );
    });

    it("textToSpeech rejects when aborted before execution", async () => {
        const cap = new GeminiAudioTextToSpeechCapabilityImpl(makeProvider(), {} as any);
        const ac = new AbortController();
        ac.abort();
        await expect(cap.textToSpeech({ input: { text: "hello" } } as any, {} as any, ac.signal)).rejects.toThrow(
            "Text-to-speech request aborted before execution"
        );
    });

    it("textToSpeech validates non-empty text", async () => {
        const cap = new GeminiAudioTextToSpeechCapabilityImpl(makeProvider(), {} as any);
        await expect(cap.textToSpeech({ input: { text: "" } } as any, {} as any)).rejects.toThrow(
            "TTS text must be a non-empty string"
        );
    });

    it("textToSpeech throws when provider returns no audio", async () => {
        const client = {
            models: {
                generateContent: vi.fn().mockResolvedValue({ responseId: "g-tts-none", candidates: [] })
            }
        } as any;

        const cap = new GeminiAudioTextToSpeechCapabilityImpl(makeProvider(), client);
        await expect(cap.textToSpeech({ input: { text: "hello", format: "wav" } } as any, {} as any)).rejects.toThrow(
            "Gemini TTS response did not contain audio data"
        );
    });

    it("textToSpeech wraps pcm/l16 as wav", async () => {
        const client = {
            models: {
                generateContent: vi.fn().mockResolvedValue({
                    responseId: "g-tts-1",
                    candidates: [
                        {
                            content: {
                                parts: [{ inlineData: { mimeType: "audio/L16;rate=24000", data: "AQIDBA==" } }]
                            }
                        }
                    ]
                })
            }
        } as any;

        const cap = new GeminiAudioTextToSpeechCapabilityImpl(makeProvider(), client);
        const res = await cap.textToSpeech({ input: { text: "hello", format: "wav" } } as any, {} as any);

        const bytes = Buffer.from(res.output[0]?.base64 ?? "", "base64");
        expect(bytes.subarray(0, 4).toString("ascii")).toBe("RIFF");
        expect(bytes.subarray(8, 12).toString("ascii")).toBe("WAVE");
        expect(res.output[0]?.mimeType).toBe("audio/wav");
    });

    it("textToSpeechStream emits deltas and final artifact", async () => {
        const stream = {
            async *[Symbol.asyncIterator]() {
                yield {
                    responseId: "g-tts-stream",
                    candidates: [{ content: { parts: [{ inlineData: { mimeType: "audio/wav", data: "AQID" } }] } }]
                };
                yield {
                    responseId: "g-tts-stream",
                    candidates: [{ content: { parts: [{ inlineData: { mimeType: "audio/wav", data: "BAUG" } }] } }]
                };
            }
        };

        const client = {
            models: {
                generateContentStream: vi.fn().mockResolvedValue(stream)
            }
        } as any;

        const cap = new GeminiAudioTextToSpeechCapabilityImpl(makeProvider(2), client);
        const chunks = await collect(cap.textToSpeechStream({ input: { text: "hello", format: "wav" } } as any, {} as any));

        const deltas = chunks.filter((c) => c.done === false);
        expect(deltas.length).toBeGreaterThanOrEqual(2);
        expect(deltas[0]?.delta?.[0]?.kind).toBe("tts");

        const final = chunks.at(-1);
        expect(final?.done).toBe(true);
        expect(final?.output?.[0]?.kind).toBe("tts");
        expect(final?.multimodalArtifacts?.tts).toHaveLength(1);
    });

    it("textToSpeechStream emits terminal error chunk when no audio arrives", async () => {
        const stream = {
            async *[Symbol.asyncIterator]() {
                yield { responseId: "g-tts-stream-empty", candidates: [{ content: { parts: [{ text: "no audio" }] } }] };
            }
        };

        const client = {
            models: {
                generateContentStream: vi.fn().mockResolvedValue(stream)
            }
        } as any;

        const cap = new GeminiAudioTextToSpeechCapabilityImpl(makeProvider(), client);
        const chunks = await collect(cap.textToSpeechStream({ input: { text: "hello", format: "wav" } } as any, {} as any));

        const final = chunks.at(-1);
        expect(final?.done).toBe(true);
        expect(final?.output).toEqual([]);
        expect(final?.metadata?.status).toBe("error");
    });

    it("textToSpeechStream uses response.data fallback audio and request-id fallback when chunk ids are absent", async () => {
        const stream = {
            async *[Symbol.asyncIterator]() {
                yield { data: "AQID" };
            }
        };

        const client = {
            models: {
                generateContentStream: vi.fn().mockResolvedValue(stream)
            }
        } as any;

        const cap = new GeminiAudioTextToSpeechCapabilityImpl(makeProvider(8), client);
        const chunks = await collect(
            cap.textToSpeechStream(
                { input: { text: "hello" }, context: { requestId: "gem-tts-fallback" } } as any,
                {} as any
            )
        );

        expect(chunks).toHaveLength(2);
        expect(chunks[0]?.done).toBe(false);
        expect(chunks[0]?.id).toBe("gem-tts-fallback");
        expect(chunks[0]?.delta?.[0]?.base64).toBe("AQID");
        expect(chunks.at(-1)?.done).toBe(true);
        expect(chunks.at(-1)?.id).toBe("gem-tts-fallback");
    });

    it("textToSpeechStream exits silently when aborted mid-stream", async () => {
        const controller = new AbortController();
        const stream = {
            async *[Symbol.asyncIterator]() {
                yield {
                    responseId: "g-tts-stream-abort",
                    candidates: [{ content: { parts: [{ inlineData: { mimeType: "audio/wav", data: "AQID" } }] } }]
                };
                controller.abort();
                yield {
                    responseId: "g-tts-stream-abort",
                    candidates: [{ content: { parts: [{ inlineData: { mimeType: "audio/wav", data: "BAUG" } }] } }]
                };
            }
        };
        const client = {
            models: {
                generateContentStream: vi.fn().mockResolvedValue(stream)
            }
        } as any;
        const cap = new GeminiAudioTextToSpeechCapabilityImpl(makeProvider(), client);
        const chunks = await collect(cap.textToSpeechStream({ input: { text: "hello" } } as any, {} as any, controller.signal));
        expect(chunks).toHaveLength(1);
        expect(chunks[0]?.done).toBe(false);
    });

    it("textToSpeechStream emits error chunk when stream setup throws non-Error", async () => {
        const cap = new GeminiAudioTextToSpeechCapabilityImpl(makeProvider(), {
            models: { generateContentStream: vi.fn().mockRejectedValue("upstream string failure") }
        } as any);
        const chunks = await collect(cap.textToSpeechStream({ input: { text: "hello" } } as any, {} as any));
        expect(chunks).toHaveLength(1);
        expect(chunks[0]?.done).toBe(true);
        expect(chunks[0]?.metadata?.status).toBe("error");
        expect(chunks[0]?.metadata?.error).toBe("upstream string failure");
    });

    it("textToSpeechStream suppresses error chunks when setup fails after caller aborts", async () => {
        const controller = new AbortController();
        const cap = new GeminiAudioTextToSpeechCapabilityImpl(makeProvider(), {
            models: {
                generateContentStream: vi.fn().mockImplementation(async () => {
                    controller.abort();
                    throw new Error("late setup failure");
                })
            }
        } as any);

        const chunks = await collect(
            cap.textToSpeechStream({ input: { text: "hello" } } as any, {} as any, controller.signal)
        );
        expect(chunks).toEqual([]);
    });

    it("helper methods cover mime normalization and pcm wrapping branches", () => {
        const cap = new GeminiAudioTextToSpeechCapabilityImpl(makeProvider(), {} as any);

        expect((cap as any).normalizeGeminiAudioMimeType(undefined)).toBeUndefined();
        expect((cap as any).normalizeGeminiAudioMimeType("")).toBeUndefined();
        expect((cap as any).normalizeGeminiAudioMimeType("audio/L16;rate=24000")).toBe("audio/pcm");
        expect((cap as any).normalizeGeminiAudioMimeType("audio/linear16")).toBe("audio/pcm");
        expect((cap as any).normalizeGeminiAudioMimeType("audio/x-wav")).toBe("audio/wav");
        expect((cap as any).normalizeGeminiAudioMimeType("audio/ogg")).toBe("audio/ogg");

        const concatenated = (cap as any).concatBase64Chunks(["AQID", "BAUG"]);
        expect(concatenated.equals(Buffer.from([1, 2, 3, 4, 5, 6]))).toBe(true);

        const playablePcm = (cap as any).toPlayableAudio(Buffer.from([1, 2, 3, 4]), "audio/pcm");
        expect(playablePcm.mimeType).toBe("audio/wav");
        expect(playablePcm.bytes.subarray(0, 4).toString("ascii")).toBe("RIFF");

        const playableOther = (cap as any).toPlayableAudio(Buffer.from([7, 8]), "audio/ogg");
        expect(playableOther.mimeType).toBe("audio/ogg");
        expect(playableOther.bytes.equals(Buffer.from([7, 8]))).toBe(true);
    });
});
