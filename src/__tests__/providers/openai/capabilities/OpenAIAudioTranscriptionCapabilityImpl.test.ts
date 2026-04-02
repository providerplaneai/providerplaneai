import { describe, expect, it, vi } from "vitest";
import { writeFile } from "node:fs/promises";
import { Readable } from "node:stream";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileNameFromPath, isBlobLike, parseDataUriToBuffer } from "#root/index.js";
import { OpenAIAudioTranscriptionCapabilityImpl } from "#root/providers/openai/capabilities/OpenAIAudioTranscriptionCapabilityImpl.js";
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

async function collect<T>(iter: AsyncGenerator<T>): Promise<T[]> {
    const out: T[] = [];
    for await (const item of iter) {
        out.push(item);
    }
    return out;
}

describe("OpenAIAudioTranscriptionCapabilityImpl", () => {
    it("transcribeAudio rejects when aborted before execution", async () => {
        const cap = new OpenAIAudioTranscriptionCapabilityImpl(makeProvider(), {} as any);
        const ac = new AbortController();
        ac.abort();
        await expect(cap.transcribeAudio({ input: { file: Buffer.from("abc") } } as any, {} as any, ac.signal)).rejects.toThrow(
            "Audio transcription request aborted before execution"
        );
    });

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

    it("transcribeAudio extracts text from object payloads and generates an id when request context is absent", async () => {
        const create = vi.fn().mockResolvedValue({ id: "provider-tr-1", text: "provider transcript" });
        const client = { audio: { transcriptions: { create } } } as any;
        const cap = new OpenAIAudioTranscriptionCapabilityImpl(makeProvider(), client);

        const res = await cap.transcribeAudio(
            {
                input: { file: Buffer.from("abc"), filename: "clip.wav", mimeType: "audio/wav" }
            } as any,
            {} as any
        );

        expect(res.id).toBeTypeOf("string");
        expect(res.output[0]?.content?.[0]).toEqual({ type: "text", text: "provider transcript" });
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

    it("transcribeAudioStream validates required file input", async () => {
        const cap = new OpenAIAudioTranscriptionCapabilityImpl(makeProvider(), {} as any);
        await expect(collect(cap.transcribeAudioStream({ input: {} } as any, {} as any))).rejects.toThrow(
            "Audio transcription requires a non-empty 'file' input"
        );
    });

    it("transcribeAudioStream exits immediately when signal is already aborted", async () => {
        const ac = new AbortController();
        ac.abort();
        const create = vi.fn();
        const cap = new OpenAIAudioTranscriptionCapabilityImpl(
            makeProvider(),
            { audio: { transcriptions: { create } } } as any
        );

        const chunks = await collect(
            cap.transcribeAudioStream({ input: { file: Buffer.from("abc") } } as any, {} as any, ac.signal)
        );
        expect(chunks).toEqual([]);
        expect(create).not.toHaveBeenCalled();
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

    it("transcribeAudioStream uses request id fallback when the stream omits a final done event", async () => {
        const stream = {
            async *[Symbol.asyncIterator]() {
                yield { type: "transcript.text.delta", delta: "fallback" };
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
                { input: { file: Buffer.from("abc") }, context: { requestId: "tx-fallback-id" } } as any,
                {} as any
            )
        );

        const final = chunks.at(-1);
        expect(final?.done).toBe(true);
        expect(final?.id).toBe("tx-fallback-id");
        expect(final?.output?.[0]?.id).toBe("tx-fallback-id");
        expect(final?.output?.[0]?.content?.[0]).toEqual({ type: "text", text: "fallback" });
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

    it("transcribeAudioStream emits terminal error chunk when stream setup fails", async () => {
        const client = {
            audio: {
                transcriptions: {
                    create: vi.fn().mockRejectedValue(new Error("network failure"))
                }
            }
        } as any;

        const cap = new OpenAIAudioTranscriptionCapabilityImpl(makeProvider(), client);
        const chunks = await collect(cap.transcribeAudioStream({ input: { file: Buffer.from("abc") } } as any, {} as any));
        expect(chunks).toHaveLength(1);
        expect(chunks[0]?.done).toBe(true);
        expect(chunks[0]?.metadata?.status).toBe("error");
        expect(String(chunks[0]?.metadata?.error)).toContain("network failure");
    });

    it("transcribeAudioStream suppresses terminal error chunk when caller aborts during failure path", async () => {
        const ac = new AbortController();
        const client = {
            audio: {
                transcriptions: {
                    create: vi.fn().mockImplementation(async () => {
                        ac.abort();
                        throw new Error("upstream failure after abort");
                    })
                }
            }
        } as any;

        const cap = new OpenAIAudioTranscriptionCapabilityImpl(makeProvider(), client);
        const chunks = await collect(
            cap.transcribeAudioStream({ input: { file: Buffer.from("abc") } } as any, {} as any, ac.signal)
        );
        expect(chunks).toEqual([]);
    });

    it("transcribeAudioStream ignores unknown/empty events and finalizes fallback transcript", async () => {
        const stream = {
            async *[Symbol.asyncIterator]() {
                yield { type: "unknown.event" };
                yield { type: "transcript.text.delta", delta: "" };
                yield { type: "transcript.text.delta", delta: "ok" };
                yield { type: "transcript.text.done" };
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
        expect(chunks).toHaveLength(2);
        expect(chunks[0]?.done).toBe(false);
        expect(chunks[1]?.done).toBe(true);
        expect(chunks[1]?.output?.[0]?.content?.[0]).toEqual({ type: "text", text: "ok" });
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

    it("helper methods cover parsing, message normalization, and iterable guards", async () => {
        const cap = new OpenAIAudioTranscriptionCapabilityImpl(makeProvider(), {} as any);

        expect((cap as any).extractTranscriptionText("plain")).toBe("plain");
        expect((cap as any).extractTranscriptionText({ text: "value" })).toBe("value");
        expect((cap as any).extractTranscriptionText({})).toBe("");

        const message = (cap as any).createAssistantTextMessage({
            id: "m1",
            text: "hello",
            model: "gpt-4o-transcribe",
            status: "completed",
            requestContext: { metadata: { trace: "x" } },
            raw: { provider: "raw" }
        });
        expect(message.content[0]).toEqual({ type: "text", text: "hello" });
        expect(message.metadata.trace).toBe("x");
        expect(message.raw).toEqual({ provider: "raw" });
        const emptyMessage = (cap as any).createAssistantTextMessage({
            id: "m2",
            text: "",
            model: "gpt-4o-transcribe",
            status: "incomplete"
        });
        expect(emptyMessage.content).toEqual([]);

        expect(parseDataUriToBuffer("data:audio/mpeg;base64,AQID")).toEqual({
            bytes: Buffer.from([1, 2, 3]),
            mimeType: "audio/mpeg"
        });
        expect(parseDataUriToBuffer("data:text/plain,hello%20world")).toEqual({
            bytes: Buffer.from("hello world", "utf8"),
            mimeType: "text/plain"
        });
        expect(parseDataUriToBuffer("data:;base64,AQID")).toEqual({
            bytes: Buffer.from([1, 2, 3]),
            mimeType: "application/octet-stream"
        });
        expect(() => parseDataUriToBuffer("data:audio/mpeg;base64")).toThrow("Invalid data URL");

        expect(fileNameFromPath("/tmp/a.wav", "audio-input")).toBe("a.wav");
        expect(fileNameFromPath("C:\\tmp\\a.wav", "audio-input")).toBe("a.wav");
        expect(fileNameFromPath("", "audio-input")).toBe("audio-input");

        expect(isBlobLike({ arrayBuffer: async () => new ArrayBuffer(0), type: "audio/wav" })).toBe(true);
        expect(isBlobLike({})).toBe(false);
        expect((cap as any).isAsyncIterable({ [Symbol.asyncIterator]: async function* () { yield 1; } })).toBe(true);
        expect((cap as any).isAsyncIterable({})).toBe(false);

        const localPath = path.join(tmpdir(), `openai-transcription-${Date.now()}.wav`);
        await writeFile(localPath, Buffer.from([1, 2, 3]));

        const fromUint8 = await toOpenAIUploadableFile(Uint8Array.from([1, 2]), "u8.wav", "audio/wav", "audio-input");
        expect(fromUint8).toBeTruthy();
        const fromArrayBuffer = await toOpenAIUploadableFile(Uint8Array.from([3, 4]).buffer, "ab.wav", undefined, "audio-input");
        expect(fromArrayBuffer).toBeTruthy();
        const fromDataUrl = await toOpenAIUploadableFile("data:audio/wav;base64,AQID", "d.wav", undefined, "audio-input");
        expect(fromDataUrl).toBeTruthy();
        const fromLocalPath = await toOpenAIUploadableFile(localPath, undefined, undefined, "audio-input");
        expect(fromLocalPath).toBeTruthy();
        const fromBlobLike = await toOpenAIUploadableFile(
            new Blob([Uint8Array.from([5, 6])], { type: "audio/wav" })
        );
        expect(fromBlobLike).toBeTruthy();
        const fromBlobLikeWithHint = await toOpenAIUploadableFile(
            new Blob([Uint8Array.from([6, 7])], { type: "audio/wav" }),
            "blob.wav",
            "audio/flac",
            "audio-input"
        );
        expect(fromBlobLikeWithHint).toBeTruthy();
        const fromStream = await toOpenAIUploadableFile(Readable.from([Buffer.from([7, 8])]), undefined, undefined, "audio-input");
        expect(fromStream).toBeTruthy();
    });

    it("transcribeAudio forwards optional params and merged provider overrides", async () => {
        const provider = makeProvider();
        provider.getMergedOptions = vi.fn().mockReturnValue({
            model: "gpt-4o-transcribe",
            modelParams: { temperature: 0.2 },
            providerParams: { user: "u-42" },
            generalParams: {}
        });
        const create = vi.fn().mockResolvedValue({ text: "hi" });
        const cap = new OpenAIAudioTranscriptionCapabilityImpl(
            provider,
            { audio: { transcriptions: { create } } } as any
        );

        await cap.transcribeAudio(
            {
                input: {
                    file: Buffer.from("abc"),
                    language: "en",
                    prompt: "domain terms",
                    temperature: 0.1,
                    responseFormat: "verbose_json",
                    include: ["logprobs"]
                }
            } as any,
            {} as any
        );

        expect(create).toHaveBeenCalledWith(
            expect.objectContaining({
                model: "gpt-4o-transcribe",
                language: "en",
                prompt: "domain terms",
                temperature: 0.2,
                response_format: "verbose_json",
                include: ["logprobs"],
                user: "u-42"
            }),
            expect.any(Object)
        );
    });
});
