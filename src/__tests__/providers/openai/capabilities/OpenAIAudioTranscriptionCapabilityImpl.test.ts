import { describe, expect, it, vi } from "vitest";
import { OpenAIAudioTranscriptionCapabilityImpl } from "#root/providers/openai/capabilities/OpenAIAudioTranscriptionCapabilityImpl.js";

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

async function collect<T>(iter: AsyncGenerator<T>): Promise<T[]> {
    const out: T[] = [];
    for await (const item of iter) {
        out.push(item);
    }
    return out;
}

describe("OpenAIAudioTranscriptionCapabilityImpl", () => {
    it("transcribeAudio validates required file input", async () => {
        const cap = new OpenAIAudioTranscriptionCapabilityImpl(makeProvider(), {} as any);
        await expect(cap.transcribeAudio({ input: {} } as any, {} as any)).rejects.toThrow(
            "Audio transcription requires a non-empty 'file' input"
        );
    });

    it("transcribeAudio rejects string input that is not a data URL or local path", async () => {
        const client = { audio: { transcriptions: { create: vi.fn() } } } as any;
        const cap = new OpenAIAudioTranscriptionCapabilityImpl(makeProvider(), client);

        await expect(
            cap.transcribeAudio(
                { input: { file: "this-is-not-a-real-path-or-data-url" } } as any,
                {} as any
            )
        ).rejects.toThrow("String audio input must be a data URL or local file path");
    });

    it("transcribeAudio maps non-stream response to normalized chat artifact", async () => {
        const create = vi.fn().mockResolvedValue({ text: "hello transcript" });
        const client = { audio: { transcriptions: { create } } } as any;
        const cap = new OpenAIAudioTranscriptionCapabilityImpl(makeProvider(), client);

        const res = await cap.transcribeAudio(
            {
                input: { file: Buffer.from("abc"), filename: "clip.wav", mimeType: "audio/wav" },
                context: { requestId: "req-1", metadata: { trace: "x" } }
            } as any,
            {} as any
        );

        expect(res.output[0]?.role).toBe("assistant");
        expect(res.output[0]?.content?.[0]).toEqual({ type: "text", text: "hello transcript" });
        expect(res.multimodalArtifacts?.chat).toHaveLength(1);
        expect(res.metadata?.provider).toBe("openai");
        expect(res.id).toBe("req-1");
        expect(create).toHaveBeenCalledTimes(1);
    });

    it("transcribeAudioStream emits incremental and final chunks", async () => {
        const stream = {
            async *[Symbol.asyncIterator]() {
                yield { type: "transcript.text.delta", delta: "hel" };
                yield { type: "transcript.text.delta", delta: "lo" };
                yield { type: "transcript.text.done", text: "hello" };
            }
        };

        const client = {
            audio: {
                transcriptions: {
                    create: vi.fn().mockResolvedValue(stream)
                }
            }
        } as any;

        const cap = new OpenAIAudioTranscriptionCapabilityImpl(makeProvider(), client);
        const chunks = await collect(
            cap.transcribeAudioStream(
                {
                    input: { file: Buffer.from("abc"), filename: "clip.wav", mimeType: "audio/wav" },
                    context: { requestId: "req-stream" }
                } as any,
                {} as any
            )
        );

        expect(chunks[0]?.done).toBe(false);
        expect(chunks[0]?.delta?.[0]?.content?.[0]).toEqual({ type: "text", text: "hel" });
        expect(chunks.at(-1)?.done).toBe(true);
        expect(chunks.at(-1)?.output?.[0]?.content?.[0]).toEqual({ type: "text", text: "hello" });
        expect(chunks.at(-1)?.multimodalArtifacts?.chat).toHaveLength(1);
    });

    it("transcribeAudioStream falls back to terminal chunk when done event is missing", async () => {
        const stream = {
            async *[Symbol.asyncIterator]() {
                yield { type: "transcript.text.delta", delta: "large-" };
                yield { type: "transcript.text.delta", delta: "output" };
            }
        };

        const client = {
            audio: {
                transcriptions: {
                    create: vi.fn().mockResolvedValue(stream)
                }
            }
        } as any;

        const cap = new OpenAIAudioTranscriptionCapabilityImpl(makeProvider(), client);
        const chunks = await collect(cap.transcribeAudioStream({ input: { file: Buffer.from("abc") } } as any, {} as any));

        const final = chunks.at(-1);
        expect(final?.done).toBe(true);
        expect(final?.output?.[0]?.content?.[0]).toEqual({ type: "text", text: "large-output" });
    });

    it("transcribeAudioStream emits terminal error chunk for non-iterable stream response", async () => {
        const client = {
            audio: {
                transcriptions: {
                    create: vi.fn().mockResolvedValue({ text: "not-a-stream" })
                }
            }
        } as any;

        const cap = new OpenAIAudioTranscriptionCapabilityImpl(makeProvider(), client);
        const chunks = await collect(cap.transcribeAudioStream({ input: { file: Buffer.from("abc") } } as any, {} as any));

        const final = chunks.at(-1);
        expect(final?.done).toBe(true);
        expect(final?.output).toEqual([]);
        expect(final?.metadata?.status).toBe("error");
        expect(String(final?.metadata?.error)).toContain("did not return an async iterable");
    });

    it("transcribeAudioStream handles abort during streaming without terminal error chunk", async () => {
        const controller = new AbortController();

        const stream = {
            async *[Symbol.asyncIterator]() {
                yield { type: "transcript.text.delta", delta: "first" };
                controller.abort();
                yield { type: "transcript.text.delta", delta: "second" };
            }
        };

        const client = {
            audio: {
                transcriptions: {
                    create: vi.fn().mockResolvedValue(stream)
                }
            }
        } as any;

        const cap = new OpenAIAudioTranscriptionCapabilityImpl(makeProvider(), client);
        const chunks = await collect(
            cap.transcribeAudioStream(
                { input: { file: Buffer.from("abc") } } as any,
                {} as any,
                controller.signal
            )
        );

        expect(chunks).toHaveLength(1);
        expect(chunks[0]?.done).toBe(false);
        expect(chunks[0]?.delta?.[0]?.content?.[0]).toEqual({ type: "text", text: "first" });
    });
});
