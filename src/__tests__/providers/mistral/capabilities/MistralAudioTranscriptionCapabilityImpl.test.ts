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

    it("transcribeAudio decodes data URIs into uploaded file content", async () => {
        const complete = vi.fn().mockResolvedValue({
            model: "voxtral-mini-latest",
            text: "data uri transcript",
            usage: { promptTokens: 2, totalTokens: 2 },
            language: "en"
        });
        const cap = new MistralAudioTranscriptionCapabilityImpl(makeProvider(), {
            audio: { transcriptions: { complete } }
        } as any);

        await cap.transcribeAudio(
            {
                input: {
                    file: "data:audio/mpeg;base64,AQID",
                    filename: "inline.mp3"
                }
            } as any,
            {} as any
        );

        expect(complete).toHaveBeenCalledWith(
            expect.objectContaining({
                file: expect.objectContaining({
                    fileName: "inline.mp3",
                    content: expect.any(Uint8Array)
                })
            }),
            expect.any(Object)
        );
    });

    it("transcribeAudio does not let modelParams override normalized request fields", async () => {
        const provider = makeProvider();
        provider.getMergedOptions = vi.fn().mockReturnValue({
            model: "voxtral-mini-latest",
            modelParams: {
                model: "wrong-model",
                fileUrl: "https://wrong.example.com/audio.mp3",
                stream: true,
                contextBias: ["wrong"],
                customFlag: true
            },
            providerParams: {},
            generalParams: {}
        });
        const complete = vi.fn().mockResolvedValue({
            model: "voxtral-mini-latest",
            text: "override-safe transcript",
            usage: { promptTokens: 2, totalTokens: 2 },
            language: "en"
        });
        const cap = new MistralAudioTranscriptionCapabilityImpl(provider, {
            audio: { transcriptions: { complete } }
        } as any);

        await cap.transcribeAudio(
            {
                input: {
                    file: "https://example.com/audio.mp3",
                    knownSpeakerNames: ["alice"]
                }
            } as any,
            {} as any
        );

        expect(complete).toHaveBeenCalledWith(
            expect.objectContaining({
                model: "voxtral-mini-latest",
                fileUrl: "https://example.com/audio.mp3",
                contextBias: ["alice"],
                stream: false,
                customFlag: true
            }),
            expect.any(Object)
        );
    });

    it("transcribeAudio handles unnamed blobs and rejects invalid data URIs", async () => {
        const complete = vi.fn().mockResolvedValue({
            model: "voxtral-mini-latest",
            text: "blob transcript",
            usage: { promptTokens: 2, totalTokens: 2 },
            language: "en"
        });
        const cap = new MistralAudioTranscriptionCapabilityImpl(makeProvider(), {
            audio: { transcriptions: { complete } }
        } as any);

        await cap.transcribeAudio(
            {
                input: {
                    file: new Blob([Buffer.from("blob-audio")], { type: "" }),
                    mimeType: "audio/wav"
                }
            } as any,
            {} as any
        );

        expect(complete).toHaveBeenCalledWith(
            expect.objectContaining({
                file: expect.objectContaining({
                    fileName: "audio-input",
                    content: expect.any(Blob)
                })
            }),
            expect.any(Object)
        );
        expect((complete.mock.calls[0][0].file.content as Blob).type).toBe("audio/wav");

        await expect(
            cap.transcribeAudio(
                {
                    input: {
                        file: "data:audio/mpeg;base64"
                    }
                } as any,
                {} as any
            )
        ).rejects.toThrow("Invalid data URL");
    });

    it("transcribeAudio aborts while reading file and stream inputs", async () => {
        const tempPath = path.join(tmpdir(), `mistral-audio-abort-${Date.now()}.mp3`);
        await writeFile(tempPath, Buffer.from([1, 2, 3]));

        const cap = new MistralAudioTranscriptionCapabilityImpl(makeProvider(), {
            audio: { transcriptions: { complete: vi.fn() } }
        } as any);

        const fileController = new AbortController();
        fileController.abort();
        await expect(
            cap.transcribeAudio({ input: { file: tempPath } } as any, {} as any, fileController.signal)
        ).rejects.toThrow("Audio transcription request aborted before execution");

        const streamController = new AbortController();
        const stream = Readable.from(
            (async function* () {
                yield Buffer.from("ab");
                streamController.abort();
                yield Buffer.from("cd");
            })()
        );

        await expect(
            cap.transcribeAudio({ input: { file: stream } } as any, {} as any, streamController.signal)
        ).rejects.toThrow("Audio transcription request aborted while reading stream input");
    });

    it("transcribeAudio does not dispatch request when signal is aborted during file read", async () => {
        const complete = vi.fn();
        const cap = new MistralAudioTranscriptionCapabilityImpl(makeProvider(), {
            audio: { transcriptions: { complete } }
        } as any);

        const tempPath = path.join(tmpdir(), `mistral-audio-post-read-abort-${Date.now()}.mp3`);
        await writeFile(tempPath, Buffer.from([1, 2, 3]));

        const controller = new AbortController();
        controller.abort();

        await expect(
            cap.transcribeAudio({ input: { file: tempPath } } as any, {} as any, controller.signal)
        ).rejects.toThrow("Audio transcription request aborted before execution");
        expect(complete).not.toHaveBeenCalled();
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

    it("transcribeAudioStream emits a fallback completed chunk when the stream ends without transcription.done", async () => {
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
            }
        };

        const cap = new MistralAudioTranscriptionCapabilityImpl(makeProvider(), {
            audio: { transcriptions: { stream: vi.fn().mockResolvedValue(stream) } }
        } as any);

        const chunks = await collect(
            cap.transcribeAudioStream(
                { input: { file: Buffer.from("abc") }, context: { requestId: "mistral-stream-fallback" } } as any,
                {} as any
            )
        );

        expect(chunks).toHaveLength(3);
        expect(chunks[2]).toMatchObject({
            done: true,
            id: "mistral-stream-fallback",
            metadata: {
                provider: "mistral",
                status: "completed"
            }
        });
        expect(chunks[2]?.output?.[0]?.content?.[0]).toEqual({ type: "text", text: "hello world" });
    });

    it("transcribeAudioStream emits a terminal error chunk on provider failure", async () => {
        const cap = new MistralAudioTranscriptionCapabilityImpl(makeProvider(), {
            audio: { transcriptions: { stream: vi.fn().mockRejectedValue(new Error("stream boom")) } }
        } as any);

        const chunks = await collect(
            cap.transcribeAudioStream(
                {
                    input: { file: Buffer.from("abc") },
                    context: { requestId: "mistral-stream-error", metadata: { source: "test" } }
                } as any,
                {} as any
            )
        );

        expect(chunks).toHaveLength(1);
        expect(chunks[0]).toMatchObject({
            done: true,
            id: "mistral-stream-error",
            output: [],
            delta: [],
            metadata: {
                provider: "mistral",
                status: "error",
                requestId: "mistral-stream-error",
                error: "stream boom",
                source: "test"
            }
        });
    });

    it("rejects unsupported input types", async () => {
        const cap = new MistralAudioTranscriptionCapabilityImpl(makeProvider(), {} as any);
        await expect(
            cap.transcribeAudio({ input: { file: {} as unknown as string } } as any, {} as any)
        ).rejects.toThrow("Unsupported Mistral transcription input type");
    });

    it("transcribeAudio accepts Uint8Array and ArrayBuffer inputs", async () => {
        const complete = vi.fn().mockResolvedValue({
            model: "voxtral-mini-latest",
            text: "typed-array transcript",
            usage: { promptTokens: 2, totalTokens: 2 },
            language: "en"
        });
        const cap = new MistralAudioTranscriptionCapabilityImpl(makeProvider(), {
            audio: { transcriptions: { complete } }
        } as any);

        await cap.transcribeAudio({ input: { file: new Uint8Array([1, 2, 3]), filename: "typed.wav" } } as any, {} as any);
        await cap.transcribeAudio({ input: { file: new Uint8Array([4, 5, 6]).buffer, filename: "buffer.wav" } } as any, {} as any);

        expect(complete.mock.calls[0][0].file).toEqual(
            expect.objectContaining({
                fileName: "typed.wav",
                content: expect.any(Uint8Array)
            })
        );
        expect(complete.mock.calls[1][0].file).toEqual(
            expect.objectContaining({
                fileName: "buffer.wav",
                content: expect.any(Uint8Array)
            })
        );
    });

    it("transcribeAudio converts string chunks from readable streams", async () => {
        const complete = vi.fn().mockResolvedValue({
            model: "voxtral-mini-latest",
            text: "string stream transcript",
            usage: { promptTokens: 2, totalTokens: 2 },
            language: "en"
        });
        const cap = new MistralAudioTranscriptionCapabilityImpl(makeProvider(), {
            audio: { transcriptions: { complete } }
        } as any);

        await cap.transcribeAudio(
            {
                input: {
                    file: Readable.from((async function* () {
                        yield "ab";
                        yield "cd";
                    })()),
                    filename: "string-stream.wav"
                }
            } as any,
            {} as any
        );

        expect(complete).toHaveBeenCalledWith(
            expect.objectContaining({
                file: expect.objectContaining({
                    fileName: "string-stream.wav",
                    content: expect.any(Uint8Array)
                })
            }),
            expect.any(Object)
        );
    });

    it("transcribeAudio uses blob names when available and omits empty transcript content", async () => {
        const complete = vi.fn().mockResolvedValue({
            model: "voxtral-mini-latest",
            text: "",
            usage: { completionTokens: 4 },
            language: undefined
        });
        const file = new File([Buffer.from("named-audio")], "named-audio.wav", { type: "audio/wav" });
        const cap = new MistralAudioTranscriptionCapabilityImpl(makeProvider(), {
            audio: { transcriptions: { complete } }
        } as any);

        const response = await cap.transcribeAudio(
            {
                input: { file },
                context: { requestId: "named-audio-1" }
            } as any,
            {} as any
        );

        expect(complete).toHaveBeenCalledWith(
            expect.objectContaining({
                file: expect.objectContaining({
                    fileName: "named-audio.wav"
                })
            }),
            expect.any(Object)
        );
        expect(response.output[0]?.content).toEqual([]);
        expect(response.metadata?.completionTokens).toBe(4);
        expect(response.metadata?.language).toBeUndefined();
        expect(response.output[0]?.metadata?.raw).toBeDefined();
    });
});
