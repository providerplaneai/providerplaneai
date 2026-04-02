import { describe, expect, it, vi } from "vitest";
import { writeFile } from "node:fs/promises";
import { Readable } from "node:stream";
import { tmpdir } from "node:os";
import path from "node:path";
import { isBlobLike, isNodeReadableStream, parseDataUriToBase64, readNodeReadableStreamToBuffer } from "#root/index.js";
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
    it("transcribeAudio rejects when aborted before execution", async () => {
        const cap = new GeminiAudioTranscriptionCapabilityImpl(makeProvider(), {} as any);
        const ac = new AbortController();
        ac.abort();
        await expect(cap.transcribeAudio({ input: { file: Buffer.from("abc") } } as any, {} as any, ac.signal)).rejects.toThrow(
            "Audio transcription request aborted before execution"
        );
    });

    it("transcribeAudio validates required file input", async () => {
        const cap = new GeminiAudioTranscriptionCapabilityImpl(makeProvider(), {} as any);
        await expect(cap.transcribeAudio({ input: {} } as any, {} as any)).rejects.toThrow(
            "Audio transcription requires a non-empty 'file' input"
        );
    });

    it("transcribeAudioStream validates required file input", async () => {
        const cap = new GeminiAudioTranscriptionCapabilityImpl(makeProvider(), {} as any);
        await expect(collect(cap.transcribeAudioStream({ input: {} } as any, {} as any))).rejects.toThrow(
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

    it("transcribeAudio uses fallback id and empty content when response has no text/ids", async () => {
        const provider = makeProvider();
        provider.getMergedOptions = vi.fn().mockReturnValue({
            model: undefined,
            modelParams: { temperature: 0 },
            providerParams: { topK: 1 },
            generalParams: {}
        });

        const generateContent = vi.fn().mockResolvedValue({ usageMetadata: {} });
        const cap = new GeminiAudioTranscriptionCapabilityImpl(provider, { models: { generateContent } } as any);
        const res = await cap.transcribeAudio({ input: { file: Buffer.from("abc") } } as any, {} as any);

        expect(res.id).toBeTypeOf("string");
        expect(res.output[0]?.content).toEqual([]);
        expect(generateContent).toHaveBeenCalledWith(
            expect.objectContaining({
                temperature: 0,
                topK: 1
            })
        );
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

    it("transcribeAudioStream flushes trailing output with empty delta when buffer was fully flushed", async () => {
        const stream = {
            async *[Symbol.asyncIterator]() {
                yield { responseId: "g-stream-flush", text: "abcd" };
            }
        };
        const client = {
            models: {
                generateContentStream: vi.fn().mockResolvedValue(stream)
            }
        } as any;
        const cap = new GeminiAudioTranscriptionCapabilityImpl(makeProvider(4), client);
        const chunks = await collect(cap.transcribeAudioStream({ input: { file: Buffer.from("abc") } } as any, {} as any));

        // First chunk is flush chunk, second is trailing output with empty delta, third is terminal.
        expect(chunks[1]?.done).toBe(false);
        expect(chunks[1]?.delta).toEqual([]);
        expect(chunks[1]?.output?.[0]?.content?.[0]).toEqual({ type: "text", text: "abcd" });
        expect(chunks.at(-1)?.done).toBe(true);
    });

    it("transcribeAudioStream emits stringified error when provider throws non-Error", async () => {
        const client = {
            models: {
                generateContentStream: vi.fn().mockRejectedValue("provider string failure")
            }
        } as any;
        const cap = new GeminiAudioTranscriptionCapabilityImpl(makeProvider(), client);
        const chunks = await collect(cap.transcribeAudioStream({ input: { file: Buffer.from("abc") } } as any, {} as any));
        expect(chunks).toHaveLength(1);
        expect(chunks[0]?.done).toBe(true);
        expect(chunks[0]?.metadata?.status).toBe("error");
        expect(chunks[0]?.metadata?.error).toBe("provider string failure");
    });

    it("transcribeAudioStream suppresses terminal error chunks when setup fails after caller aborts", async () => {
        const controller = new AbortController();
        const client = {
            models: {
                generateContentStream: vi.fn().mockImplementation(async () => {
                    controller.abort();
                    throw new Error("late aborted setup");
                })
            }
        } as any;

        const cap = new GeminiAudioTranscriptionCapabilityImpl(makeProvider(), client);
        const chunks = await collect(
            cap.transcribeAudioStream({ input: { file: Buffer.from("abc") } } as any, {} as any, controller.signal)
        );
        expect(chunks).toEqual([]);
    });

    it("transcribeAudioStream returns immediately when already aborted before stream call", async () => {
        const ac = new AbortController();
        ac.abort();
        const client = {
            models: {
                generateContentStream: vi.fn()
            }
        } as any;
        const cap = new GeminiAudioTranscriptionCapabilityImpl(makeProvider(), client);
        const chunks = await collect(
            cap.transcribeAudioStream({ input: { file: Buffer.from("abc") } } as any, {} as any, ac.signal)
        );
        expect(chunks).toEqual([]);
        expect(client.models.generateContentStream).not.toHaveBeenCalled();
    });

    it("transcribeAudioStream includes merged params and falls back to generated ids when none are provided", async () => {
        const provider = makeProvider();
        provider.getMergedOptions = vi.fn().mockReturnValue({
            model: "models/custom-stream-transcribe",
            modelParams: { temperature: 0.2 },
            providerParams: { topP: 0.9 },
            generalParams: { audioStreamBatchSize: 4 }
        });
        const stream = {
            async *[Symbol.asyncIterator]() {
                yield { text: "abcd" };
            }
        };
        const generateContentStream = vi.fn().mockResolvedValue(stream);
        const cap = new GeminiAudioTranscriptionCapabilityImpl(provider, { models: { generateContentStream } } as any);
        const chunks = await collect(cap.transcribeAudioStream({ input: { file: Buffer.from("abc") } } as any, {} as any));

        expect(chunks[0]?.id).toBeTypeOf("string");
        expect(chunks.at(-1)?.id).toBeTypeOf("string");
        expect(generateContentStream).toHaveBeenCalledWith(
            expect.objectContaining({
                model: "custom-stream-transcribe",
                temperature: 0.2,
                topP: 0.9
            })
        );
    });

    it("transcribeAudioStream carries usage and language metadata across incremental and final chunks", async () => {
        const stream = {
            async *[Symbol.asyncIterator]() {
                yield {
                    responseId: "g-stream-usage",
                    text: "abcd",
                    usageMetadata: {
                        promptTokenCount: 3,
                        candidatesTokenCount: 2,
                        totalTokenCount: 5
                    }
                };
                yield {
                    responseId: "g-stream-usage",
                    text: "ef",
                    usageMetadata: {
                        promptTokenCount: 4,
                        candidatesTokenCount: 3,
                        totalTokenCount: 7
                    }
                };
            }
        };

        const client = {
            models: {
                generateContentStream: vi.fn().mockResolvedValue(stream)
            }
        } as any;

        const cap = new GeminiAudioTranscriptionCapabilityImpl(makeProvider(4), client);
        const chunks = await collect(
            cap.transcribeAudioStream(
                {
                    input: { file: Buffer.from("abc"), language: "fr" },
                    context: { requestId: "req-stream-usage" }
                } as any,
                {} as any
            )
        );

        expect(chunks[0]?.metadata).toMatchObject({
            provider: "gemini",
            status: "incomplete",
            language: "fr",
            inputTokens: 3,
            outputTokens: 2,
            totalTokens: 5
        });
        expect(chunks.at(-1)?.metadata).toMatchObject({
            provider: "gemini",
            status: "completed",
            language: "fr",
            inputTokens: 4,
            outputTokens: 3,
            totalTokens: 7
        });
    });

    it("transcribeAudioStream finalizes with request-id fallback and empty content when no text deltas arrive", async () => {
        const stream = {
            async *[Symbol.asyncIterator]() {
                yield { candidates: [{ content: { parts: [{ inlineData: { data: "AQID" } }] } }] };
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
                {
                    input: { file: Buffer.from("abc"), language: "en" },
                    context: { requestId: "req-stream-empty" }
                } as any,
                {} as any
            )
        );

        expect(chunks).toHaveLength(1);
        expect(chunks[0]).toMatchObject({
            done: true,
            id: "req-stream-empty",
            output: [{ id: "req-stream-empty", content: [] }],
            metadata: {
                provider: "gemini",
                status: "completed",
                requestId: "req-stream-empty",
                language: "en"
            }
        });
    });

    it("transcribeAudioStream uses request-id fallback across flush and trailing chunks when provider omits responseId", async () => {
        const stream = {
            async *[Symbol.asyncIterator]() {
                yield {
                    text: "abcd",
                    usageMetadata: {
                        promptTokenCount: 2,
                        candidatesTokenCount: 1,
                        totalTokenCount: 3
                    }
                };
                yield {
                    text: "ef",
                    usageMetadata: {
                        promptTokenCount: 2,
                        candidatesTokenCount: 2,
                        totalTokenCount: 4
                    }
                };
            }
        };

        const provider = makeProvider();
        provider.getMergedOptions = vi.fn().mockReturnValue({
            model: undefined,
            modelParams: { temperature: 0.4 },
            providerParams: { topP: 0.8 },
            generalParams: { audioStreamBatchSize: 4 }
        });

        const generateContentStream = vi.fn().mockResolvedValue(stream);
        const cap = new GeminiAudioTranscriptionCapabilityImpl(provider, { models: { generateContentStream } } as any);
        const chunks = await collect(
            cap.transcribeAudioStream(
                {
                    input: { file: Buffer.from("abc"), language: "de" },
                    context: { requestId: "req-stream-fallback", metadata: { traceId: "trace-1" } }
                } as any,
                {} as any
            )
        );

        expect(generateContentStream).toHaveBeenCalledWith(
            expect.objectContaining({
                model: "gemini-2.5-flash",
                temperature: 0.4,
                topP: 0.8
            })
        );
        expect(chunks[0]).toMatchObject({
            done: false,
            id: "req-stream-fallback",
            metadata: {
                provider: "gemini",
                requestId: "req-stream-fallback",
                language: "de",
                traceId: "trace-1",
                totalTokens: 3
            }
        });
        expect(chunks[1]).toMatchObject({
            done: false,
            id: "req-stream-fallback",
            delta: [
                {
                    content: [{ type: "text", text: "ef" }]
                }
            ],
            output: [
                {
                    id: "req-stream-fallback",
                    content: [{ type: "text", text: "abcdef" }]
                }
            ]
        });
        expect(chunks[2]).toMatchObject({
            done: true,
            id: "req-stream-fallback",
            output: [
                {
                    id: "req-stream-fallback",
                    content: [{ type: "text", text: "abcdef" }]
                }
            ],
            metadata: {
                provider: "gemini",
                status: "completed",
                requestId: "req-stream-fallback",
                language: "de",
                traceId: "trace-1",
                totalTokens: 4
            }
        });
    });

    it("transcribeAudioStream emits terminal error chunks with request-id fallback and latest usage when streaming fails mid-run", async () => {
        const client = {
            models: {
                generateContentStream: vi.fn().mockResolvedValue({
                    async *[Symbol.asyncIterator]() {
                        yield {
                            usageMetadata: {
                                promptTokenCount: 5,
                                candidatesTokenCount: 1,
                                totalTokenCount: 6
                            }
                        };
                        throw new Error("mid-stream failure");
                    }
                })
            }
        } as any;

        const cap = new GeminiAudioTranscriptionCapabilityImpl(makeProvider(), client);
        const chunks = await collect(
            cap.transcribeAudioStream(
                {
                    input: { file: Buffer.from("abc"), language: "es" },
                    context: { requestId: "req-stream-error" }
                } as any,
                {} as any
            )
        );

        expect(chunks).toEqual([
            expect.objectContaining({
                done: true,
                id: "req-stream-error",
                output: [],
                delta: [],
                metadata: expect.objectContaining({
                    provider: "gemini",
                    status: "error",
                    requestId: "req-stream-error",
                    language: "es",
                    error: "mid-stream failure",
                    inputTokens: 5,
                    outputTokens: 1,
                    totalTokens: 6
                })
            })
        ]);
    });

    it("helper methods cover extraction, instruction formats, payload parsing, and mime inference", async () => {
        const cap = new GeminiAudioTranscriptionCapabilityImpl(makeProvider(), {} as any);

        expect((cap as any).extractUsage({})).toEqual({});
        expect(
            (cap as any).extractUsage({ usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 2, totalTokenCount: 3 } })
        ).toEqual({ inputTokens: 1, outputTokens: 2, totalTokens: 3 });

        expect((cap as any).extractTextFromGeminiResponse({ text: "a" })).toBe("a");
        expect((cap as any).extractTextFromGeminiResponse({ candidates: [{ content: { parts: [{ text: "a" }, { text: "b" }] } }] })).toBe("ab");
        expect((cap as any).extractTextFromGeminiResponse({ candidates: [{ content: { parts: [{ text: "a" }, { foo: 1 }] } }] })).toBe("a");
        expect((cap as any).extractTextFromGeminiResponse({})).toBe("");

        expect((cap as any).buildTranscriptionInstruction("en", "prompt", "text")).toContain("plain text only");
        expect((cap as any).buildTranscriptionInstruction(undefined, undefined, "srt")).toContain("SRT");
        expect((cap as any).buildTranscriptionInstruction(undefined, undefined, "vtt")).toContain("WebVTT");
        expect((cap as any).buildTranscriptionInstruction(undefined, undefined, "verbose_json")).toContain("detailed JSON");
        expect((cap as any).buildTranscriptionInstruction("  ", "  ", "json")).toContain("Return the transcript text only.");

        expect(parseDataUriToBase64("data:audio/mpeg;base64,AQID")).toEqual({
            base64: "AQID",
            mimeType: "audio/mpeg"
        });
        expect(parseDataUriToBase64("data:text/plain,hello%20world")).toEqual({
            base64: Buffer.from("hello world", "utf8").toString("base64"),
            mimeType: "text/plain"
        });
        expect(parseDataUriToBase64("data:;base64,AQID")).toEqual({
            base64: "AQID",
            mimeType: "application/octet-stream"
        });
        expect(() => parseDataUriToBase64("data:audio/mpeg;base64")).toThrow("Invalid data URL");

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

        expect(isBlobLike({ arrayBuffer: async () => new ArrayBuffer(0), type: "audio/wav" })).toBe(true);
        expect(isBlobLike({})).toBe(false);
        expect(isNodeReadableStream(Readable.from(["a"]))).toBe(true);
        expect(isNodeReadableStream({})).toBe(false);

        const readBuf = await readNodeReadableStreamToBuffer(Readable.from([Buffer.from([1, 2]), "3"]));
        expect(readBuf).toEqual(Buffer.from([1, 2, 51]));

        const filePath = path.join(tmpdir(), `gemini-transcription-${Date.now()}.wav`);
        await writeFile(filePath, Buffer.from([1, 2, 3]));
        const payloadFromPath = await (cap as any).resolveAudioPayload(filePath, undefined);
        expect(payloadFromPath.mimeType).toBe("audio/wav");
        expect(payloadFromPath.base64).toBe("AQID");

        const payloadFromStream = await (cap as any).resolveAudioPayload(Readable.from([Buffer.from([4, 5])]), undefined);
        expect(payloadFromStream.base64).toBe("BAU=");

        const payloadFromBlobWithHint = await (cap as any).resolveAudioPayload(
            { type: "audio/wav", arrayBuffer: async () => Uint8Array.from([9, 9]).buffer },
            "audio/flac"
        );
        expect(payloadFromBlobWithHint.mimeType).toBe("audio/flac");

        await expect((cap as any).resolveAudioPayload({ foo: "bar" }, undefined)).rejects.toThrow(
            "Unsupported audio input source for Gemini transcription"
        );
    });
});
