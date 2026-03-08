import { describe, expect, it, vi } from "vitest";
import { GeminiAudioTranscriptionCapabilityImpl } from "#root/providers/gemini/capabilities/GeminiAudioTranscriptionCapabilityImpl.js";

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

describe("GeminiAudioTranscriptionCapabilityImpl", () => {
    it("transcribeAudio validates required file input", async () => {
        const cap = new GeminiAudioTranscriptionCapabilityImpl(makeProvider(), {} as any);
        await expect(cap.transcribeAudio({ input: {} } as any, {} as any)).rejects.toThrow(
            "Audio transcription requires a non-empty 'file' input"
        );
    });

    it("transcribeAudio rejects invalid string audio input", async () => {
        const client = { models: { generateContent: vi.fn() } } as any;
        const cap = new GeminiAudioTranscriptionCapabilityImpl(makeProvider(), client);

        await expect(
            cap.transcribeAudio(
                { input: { file: "not-a-data-url-or-file-path" } } as any,
                {} as any
            )
        ).rejects.toThrow("String audio input must be a data URL or local file path");
    });

    it("transcribeAudio maps generateContent response and usage metadata", async () => {
        const client = {
            models: {
                generateContent: vi.fn().mockResolvedValue({
                    text: "gemini transcript",
                    responseId: "g-res-1",
                    usageMetadata: {
                        promptTokenCount: 11,
                        candidatesTokenCount: 7,
                        totalTokenCount: 18
                    }
                })
            }
        } as any;

        const cap = new GeminiAudioTranscriptionCapabilityImpl(makeProvider(), client);
        const res = await cap.transcribeAudio(
            {
                input: { file: Buffer.from("abc"), filename: "clip.mp3", mimeType: "audio/mpeg" },
                context: { requestId: "req-g-1" }
            } as any,
            {} as any
        );

        expect(res.id).toBe("g-res-1");
        expect(res.output[0]?.content?.[0]).toEqual({ type: "text", text: "gemini transcript" });
        expect(res.metadata?.provider).toBe("gemini");
        expect(res.metadata?.totalTokens).toBe(18);
    });

    it("transcribeAudioStream batches large output and emits final completion chunk", async () => {
        const stream = {
            async *[Symbol.asyncIterator]() {
                yield { responseId: "g-stream-1", text: "ab" };
                yield { responseId: "g-stream-1", text: "cd" };
                yield { responseId: "g-stream-1", text: "efghij" };
            }
        };

        const client = {
            models: {
                generateContentStream: vi.fn().mockResolvedValue(stream)
            }
        } as any;

        const cap = new GeminiAudioTranscriptionCapabilityImpl(makeProvider(4), client);
        const chunks = await collect(cap.transcribeAudioStream({ input: { file: Buffer.from("abc") } } as any, {} as any));

        expect(chunks.length).toBeGreaterThanOrEqual(3);
        expect(chunks[0]?.done).toBe(false);
        expect(chunks[0]?.delta?.[0]?.content?.[0]).toEqual({ type: "text", text: "abcd" });

        const final = chunks.at(-1);
        expect(final?.done).toBe(true);
        expect(final?.output?.[0]?.content?.[0]).toEqual({ type: "text", text: "abcdefghij" });
        expect(final?.multimodalArtifacts?.chat).toHaveLength(1);
    });

    it("transcribeAudioStream handles chunks without text and still finalizes", async () => {
        const stream = {
            async *[Symbol.asyncIterator]() {
                yield { responseId: "g-stream-empty", candidates: [] };
                yield { responseId: "g-stream-empty", text: "final" };
            }
        };

        const client = {
            models: {
                generateContentStream: vi.fn().mockResolvedValue(stream)
            }
        } as any;

        const cap = new GeminiAudioTranscriptionCapabilityImpl(makeProvider(), client);
        const chunks = await collect(cap.transcribeAudioStream({ input: { file: Buffer.from("abc") } } as any, {} as any));

        const final = chunks.at(-1);
        expect(final?.done).toBe(true);
        expect(final?.output?.[0]?.content?.[0]).toEqual({ type: "text", text: "final" });
    });

    it("transcribeAudioStream emits terminal error chunk on provider failure", async () => {
        const client = {
            models: {
                generateContentStream: vi.fn().mockRejectedValue(new Error("provider stream failed"))
            }
        } as any;

        const cap = new GeminiAudioTranscriptionCapabilityImpl(makeProvider(), client);
        const chunks = await collect(cap.transcribeAudioStream({ input: { file: Buffer.from("abc") } } as any, {} as any));

        const final = chunks.at(-1);
        expect(final?.done).toBe(true);
        expect(final?.output).toEqual([]);
        expect(final?.metadata?.status).toBe("error");
        expect(final?.metadata?.error).toBe("provider stream failed");
    });

    it("transcribeAudioStream exits quietly on abort timing race", async () => {
        const controller = new AbortController();

        const stream = {
            async *[Symbol.asyncIterator]() {
                yield { responseId: "g-stream-abort", text: "hello" };
                controller.abort();
                yield { responseId: "g-stream-abort", text: " world" };
            }
        };

        const client = {
            models: {
                generateContentStream: vi.fn().mockResolvedValue(stream)
            }
        } as any;

        const cap = new GeminiAudioTranscriptionCapabilityImpl(makeProvider(), client);
        const chunks = await collect(
            cap.transcribeAudioStream(
                { input: { file: Buffer.from("abc") } } as any,
                {} as any,
                controller.signal
            )
        );

        // First buffered chunk can still emit before abort is observed by the loop.
        expect(chunks.length).toBeLessThanOrEqual(1);
        if (chunks[0]) {
            expect(chunks[0].done).toBe(false);
            expect(chunks[0].delta?.[0]?.content?.[0]).toEqual({ type: "text", text: "hello" });
        }
    });
});
