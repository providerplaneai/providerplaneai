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
});
