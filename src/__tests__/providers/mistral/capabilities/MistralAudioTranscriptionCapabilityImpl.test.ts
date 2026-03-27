import { describe, expect, it, vi } from "vitest";
import { writeFile } from "node:fs/promises";
import { Readable } from "node:stream";
import { tmpdir } from "node:os";
import path from "node:path";
import { MistralAudioTranscriptionCapabilityImpl } from "#root/providers/mistral/capabilities/MistralAudioTranscriptionCapabilityImpl.js";

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

describe("MistralAudioTranscriptionCapabilityImpl", () => {
    it("transcribeAudio rejects when aborted before execution", async () => {
        const cap = new MistralAudioTranscriptionCapabilityImpl(makeProvider(), {} as any);
        const ac = new AbortController();
        ac.abort();
        await expect(cap.transcribeAudio({ input: { file: Buffer.from("abc") } } as any, {} as any, ac.signal)).rejects.toThrow(
            "Audio transcription request aborted before execution"
        );
    });

    it("transcribeAudio validates required file input", async () => {
        const cap = new MistralAudioTranscriptionCapabilityImpl(makeProvider(), {} as any);
        await expect(cap.transcribeAudio({ input: {} } as any, {} as any)).rejects.toThrow(
            "Audio transcription requires a non-empty 'file' input"
        );
    });

    it("transcribeAudioStream validates required file input", async () => {
        const cap = new MistralAudioTranscriptionCapabilityImpl(makeProvider(), {} as any);
        await expect(collect(cap.transcribeAudioStream({ input: {} } as any, {} as any))).rejects.toThrow(
            "Audio transcription requires a non-empty 'file' input"
        );
    });

    it("transcribeAudio handles local file paths and normalizes response metadata", async () => {
        const tempPath = path.join(tmpdir(), `mistral-audio-${Date.now()}.mp3`);
        await writeFile(tempPath, Buffer.from([1, 2, 3]));

        const complete = vi.fn().mockResolvedValue({
            model: "voxtral-mini-latest",
            text: "hello from mistral transcript",
            usage: { promptTokens: 5, totalTokens: 5 },
            language: "en"
        });
        const cap = new MistralAudioTranscriptionCapabilityImpl(makeProvider(), {
            audio: { transcriptions: { complete } }
        } as any);

        const res = await cap.transcribeAudio(
            { input: { file: tempPath }, context: { requestId: "mistral-audio-file" } } as any,
            {} as any
        );

        expect(res.id).toBe("mistral-audio-file");
        expect(res.output[0]?.content?.[0]).toEqual({ type: "text", text: "hello from mistral transcript" });
        expect(res.metadata?.provider).toBe("mistral");
        expect(res.metadata?.totalTokens).toBe(5);
        expect(complete).toHaveBeenCalledWith(
            expect.objectContaining({
                file: expect.objectContaining({ fileName: path.basename(tempPath) })
            }),
            expect.any(Object)
        );
    });

    it("transcribeAudio forwards remote URLs without local file conversion", async () => {
        const complete = vi.fn().mockResolvedValue({
            model: "voxtral-mini-latest",
            text: "remote transcript",
            usage: { promptTokens: 2, totalTokens: 2 },
            language: "en"
        });
        const cap = new MistralAudioTranscriptionCapabilityImpl(makeProvider(), {
            audio: { transcriptions: { complete } }
        } as any);

        await cap.transcribeAudio(
            { input: { file: "https://example.com/audio.mp3", knownSpeakerNames: ["alice"] } } as any,
            {} as any
        );

        expect(complete).toHaveBeenCalledWith(
            expect.objectContaining({
                fileUrl: "https://example.com/audio.mp3",
                contextBias: ["alice"]
            }),
            expect.any(Object)
        );
    });

    it("transcribeAudio converts Node streams to file uploads", async () => {
        const complete = vi.fn().mockResolvedValue({
            model: "voxtral-mini-latest",
            text: "stream transcript",
            usage: { promptTokens: 2, totalTokens: 2 },
            language: "en"
        });
        const cap = new MistralAudioTranscriptionCapabilityImpl(makeProvider(), {
            audio: { transcriptions: { complete } }
        } as any);

        await cap.transcribeAudio(
            { input: { file: Readable.from([Buffer.from("ab"), Buffer.from("cd")]), filename: "stream.wav" } } as any,
            {} as any
        );

        expect(complete).toHaveBeenCalledWith(
            expect.objectContaining({
                file: expect.objectContaining({ fileName: "stream.wav" })
            }),
            expect.any(Object)
        );
    });

    it("transcribeAudioStream emits deltas and final transcript", async () => {
        const stream = {
            async *[Symbol.asyncIterator]() {
                yield {
                    event: "transcription.text.delta",
                    data: { type: "transcription.text.delta", text: "hello " }
                };
                yield {
                    event: "transcription.text.delta",
                    data: { type: "transcription.text.delta", text: "world" }
                };
                yield {
                    event: "transcription.done",
                    data: {
                        type: "transcription.done",
                        model: "voxtral-mini-latest",
                        text: "hello world",
                        usage: { promptTokens: 7, totalTokens: 7 },
                        language: "en"
                    }
                };
            }
        };

        const cap = new MistralAudioTranscriptionCapabilityImpl(makeProvider(), {
            audio: { transcriptions: { stream: vi.fn().mockResolvedValue(stream) } }
        } as any);

        const chunks = await collect(
            cap.transcribeAudioStream(
                { input: { file: Buffer.from("abc") }, context: { requestId: "mistral-stream-1" } } as any,
                {} as any
            )
        );

        expect(chunks).toHaveLength(3);
        expect(chunks[0]?.done).toBe(false);
        expect(chunks[0]?.delta?.[0]?.content?.[0]).toEqual({ type: "text", text: "hello " });
        expect(chunks[1]?.output?.[0]?.content?.[0]).toEqual({ type: "text", text: "hello world" });
        expect(chunks[2]?.done).toBe(true);
        expect(chunks[2]?.output?.[0]?.content?.[0]).toEqual({ type: "text", text: "hello world" });
        expect(chunks[2]?.metadata?.totalTokens).toBe(7);
    });

    it("transcribeAudioStream skips empty delta frames and exits quietly on abort", async () => {
        const controller = new AbortController();
        const stream = {
            async *[Symbol.asyncIterator]() {
                yield {
                    event: "transcription.text.delta",
                    data: { type: "transcription.text.delta", text: "" }
                };
                yield {
                    event: "transcription.text.delta",
                    data: { type: "transcription.text.delta", text: "hello" }
                };
                controller.abort();
                yield {
                    event: "transcription.text.delta",
                    data: { type: "transcription.text.delta", text: " world" }
                };
            }
        };

        const cap = new MistralAudioTranscriptionCapabilityImpl(makeProvider(), {
            audio: { transcriptions: { stream: vi.fn().mockResolvedValue(stream) } }
        } as any);

        const chunks = await collect(cap.transcribeAudioStream({ input: { file: Buffer.from("abc") } } as any, {} as any, controller.signal));

        expect(chunks).toHaveLength(1);
        expect(chunks[0]?.done).toBe(false);
        expect(chunks[0]?.delta?.[0]?.content?.[0]).toEqual({ type: "text", text: "hello" });
    });

    it("rejects unsupported input types", async () => {
        const cap = new MistralAudioTranscriptionCapabilityImpl(makeProvider(), {} as any);
        await expect(
            cap.transcribeAudio({ input: { file: {} as unknown as string } } as any, {} as any)
        ).rejects.toThrow("Unsupported Mistral transcription input type");
    });
});
