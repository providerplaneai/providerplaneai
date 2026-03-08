import { describe, expect, it, vi } from "vitest";
import { OpenAIAudioTextToSpeechCapabilityImpl } from "#root/providers/openai/capabilities/OpenAIAudioTextToSpeechCapabilityImpl.js";

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

function createReadableBody(chunks: Uint8Array[]) {
    let i = 0;
    return {
        getReader() {
            return {
                async read() {
                    if (i >= chunks.length) {
                        return { done: true, value: undefined };
                    }
                    return { done: false, value: chunks[i++] };
                },
                releaseLock() {}
            };
        }
    };
}

describe("OpenAIAudioTextToSpeechCapabilityImpl", () => {
    it("textToSpeech rejects when aborted before execution", async () => {
        const cap = new OpenAIAudioTextToSpeechCapabilityImpl(makeProvider(), {} as any);
        const ac = new AbortController();
        ac.abort();
        await expect(cap.textToSpeech({ input: { text: "hello" } } as any, {} as any, ac.signal)).rejects.toThrow(
            "Text-to-speech request aborted before execution"
        );
    });

    it("textToSpeech validates non-empty text", async () => {
        const cap = new OpenAIAudioTextToSpeechCapabilityImpl(makeProvider(), {} as any);
        await expect(cap.textToSpeech({ input: { text: "   " } } as any, {} as any)).rejects.toThrow(
            "TTS text must be a non-empty string"
        );
    });

    it("textToSpeech forwards optional fields and merged provider params", async () => {
        const provider = makeProvider();
        provider.getMergedOptions = vi.fn().mockReturnValue({
            model: "gpt-4o-mini-tts",
            modelParams: { voice: "verse", response_format: "aac" },
            providerParams: { user: "u-1" },
            generalParams: {}
        });
        const create = vi.fn().mockResolvedValue({
            id: "tts-opt",
            status: 200,
            headers: { get: vi.fn().mockReturnValue("audio/aac") },
            arrayBuffer: vi.fn().mockResolvedValue(Uint8Array.from([1]).buffer)
        });
        const cap = new OpenAIAudioTextToSpeechCapabilityImpl(provider, { audio: { speech: { create } } } as any);

        await cap.textToSpeech(
            {
                input: { text: "hello", instructions: "warm", speed: 1.1, streamFormat: "audio" }
            } as any,
            {} as any
        );

        expect(create).toHaveBeenCalledWith(
            expect.objectContaining({
                model: "gpt-4o-mini-tts",
                voice: "verse",
                response_format: "aac",
                instructions: "warm",
                speed: 1.1,
                stream_format: "audio",
                user: "u-1"
            }),
            expect.any(Object)
        );
    });

    it("textToSpeech maps bytes to base64 artifact", async () => {
        const client = {
            audio: {
                speech: {
                    create: vi.fn().mockResolvedValue({
                        id: "tts-1",
                        url: "https://cdn.example.com/audio.mp3",
                        status: 200,
                        headers: { get: vi.fn().mockReturnValue("audio/mpeg") },
                        arrayBuffer: vi.fn().mockResolvedValue(Uint8Array.from([1, 2, 3]).buffer)
                    })
                }
            }
        } as any;

        const cap = new OpenAIAudioTextToSpeechCapabilityImpl(makeProvider(), client);
        const res = await cap.textToSpeech({ input: { text: "hello", format: "mp3" } } as any, {} as any);

        expect(res.id).toBe("tts-1");
        expect(res.output[0]?.base64).toBe("AQID");
        expect(res.output[0]?.kind).toBe("tts");
        expect(res.output[0]?.mimeType).toBe("audio/mpeg");
    });

    it("textToSpeech uses deterministic metadata and strips non-download endpoint URL", async () => {
        const client = {
            audio: {
                speech: {
                    create: vi.fn().mockResolvedValue({
                        id: "tts-2",
                        url: "https://api.openai.com/v1/audio/speech",
                        status: 500,
                        headers: { get: vi.fn().mockReturnValue(null) },
                        arrayBuffer: vi.fn().mockResolvedValue(Uint8Array.from([9, 8]).buffer)
                    })
                }
            }
        } as any;

        const cap = new OpenAIAudioTextToSpeechCapabilityImpl(makeProvider(), client);
        const res = await cap.textToSpeech({ input: { text: "hello", format: "wav" } } as any, {} as any);

        expect(res.output[0]?.url).toBeUndefined();
        expect(res.output[0]?.mimeType).toBe("audio/wav");
        expect(res.metadata?.status).toBe("error");
    });

    it("textToSpeechStream rejects unsupported sse format", async () => {
        const cap = new OpenAIAudioTextToSpeechCapabilityImpl(makeProvider(), {} as any);
        await expect(
            collect(cap.textToSpeechStream({ input: { text: "hello", streamFormat: "sse" } } as any, {} as any))
        ).rejects.toThrow("SSE stream format is not supported yet");
    });

    it("textToSpeechStream validates non-empty text", async () => {
        const cap = new OpenAIAudioTextToSpeechCapabilityImpl(makeProvider(), {} as any);
        await expect(collect(cap.textToSpeechStream({ input: { text: "" } } as any, {} as any))).rejects.toThrow(
            "TTS text must be a non-empty string"
        );
    });

    it("textToSpeechStream emits deltas and final artifact", async () => {
        const response = {
            id: "tts-stream-1",
            url: "https://cdn.example.com/audio.mp3",
            headers: { get: vi.fn().mockReturnValue("audio/mpeg") },
            body: createReadableBody([
                Uint8Array.from([1, 2, 3, 4]),
                Uint8Array.from([5, 6, 7])
            ])
        };

        const client = {
            audio: {
                speech: {
                    create: vi.fn().mockResolvedValue(response)
                }
            }
        } as any;

        const cap = new OpenAIAudioTextToSpeechCapabilityImpl(makeProvider(3), client);
        const chunks = await collect(cap.textToSpeechStream({ input: { text: "hello", format: "mp3" } } as any, {} as any));

        const deltaChunks = chunks.filter((c) => c.done === false);
        expect(deltaChunks.length).toBeGreaterThanOrEqual(2);
        expect(deltaChunks[0]?.delta?.[0]?.kind).toBe("tts");

        const final = chunks.at(-1);
        expect(final?.done).toBe(true);
        expect(final?.output?.[0]?.kind).toBe("tts");
        expect(final?.output?.[0]?.base64).toBe(Buffer.from([1, 2, 3, 4, 5, 6, 7]).toString("base64"));
    });

    it("textToSpeechStream skips empty values and supports zero/invalid batch size coercion", async () => {
        const response = {
            id: "tts-stream-2",
            url: "https://cdn.example.com/audio.ogg",
            headers: { get: vi.fn().mockReturnValue("audio/ogg") },
            body: createReadableBody([new Uint8Array(0), Uint8Array.from([11, 12])])
        };
        const client = {
            audio: {
                speech: {
                    create: vi.fn().mockResolvedValue(response)
                }
            }
        } as any;
        const provider = makeProvider(0);
        provider.getMergedOptions = vi.fn().mockReturnValue({
            modelParams: {},
            providerParams: {},
            generalParams: { audioStreamBatchSize: "not-a-number" }
        });

        const cap = new OpenAIAudioTextToSpeechCapabilityImpl(provider, client);
        const chunks = await collect(cap.textToSpeechStream({ input: { text: "hello", format: "ogg" } } as any, {} as any));
        const deltas = chunks.filter((c) => c.done === false);

        expect(deltas).toHaveLength(1);
        expect(deltas[0]?.delta?.[0]?.kind).toBe("tts");
        expect(chunks.at(-1)?.output?.[0]?.mimeType).toBe("audio/ogg");
    });

    it("textToSpeechStream emits terminal error chunk when body is missing", async () => {
        const client = {
            audio: {
                speech: {
                    create: vi.fn().mockResolvedValue({
                        id: "tts-stream-no-body",
                        headers: { get: vi.fn().mockReturnValue("audio/mpeg") }
                    })
                }
            }
        } as any;

        const cap = new OpenAIAudioTextToSpeechCapabilityImpl(makeProvider(), client);
        const chunks = await collect(cap.textToSpeechStream({ input: { text: "hello", format: "mp3" } } as any, {} as any));

        const final = chunks.at(-1);
        expect(final?.done).toBe(true);
        expect(final?.output).toEqual([]);
        expect(final?.metadata?.status).toBe("error");
        expect(String(final?.metadata?.error)).toContain("response body is not readable");
    });

    it("textToSpeechStream emits terminal error chunk when create fails", async () => {
        const client = {
            audio: {
                speech: {
                    create: vi.fn().mockRejectedValue(new Error("upstream down"))
                }
            }
        } as any;

        const cap = new OpenAIAudioTextToSpeechCapabilityImpl(makeProvider(), client);
        const chunks = await collect(cap.textToSpeechStream({ input: { text: "hello", format: "mp3" } } as any, {} as any));
        expect(chunks).toHaveLength(1);
        expect(chunks[0]?.done).toBe(true);
        expect(chunks[0]?.metadata?.status).toBe("error");
        expect(String(chunks[0]?.metadata?.error)).toContain("upstream down");
    });

    it("textToSpeechStream exits silently when aborted during stream", async () => {
        const controller = new AbortController();
        const streamBody = {
            getReader() {
                let i = 0;
                const chunks = [Uint8Array.from([1]), Uint8Array.from([2])];
                return {
                    async read() {
                        const value = chunks[i++];
                        if (!value) {
                            return { done: true, value: undefined };
                        }
                        controller.abort();
                        return { done: false, value };
                    },
                    releaseLock() {}
                };
            }
        };
        const client = {
            audio: {
                speech: {
                    create: vi.fn().mockResolvedValue({
                        id: "tts-stream-abort",
                        headers: { get: vi.fn().mockReturnValue("audio/mpeg") },
                        body: streamBody
                    })
                }
            }
        } as any;

        const cap = new OpenAIAudioTextToSpeechCapabilityImpl(makeProvider(), client);
        const chunks = await collect(cap.textToSpeechStream({ input: { text: "hello" } } as any, {} as any, controller.signal));
        expect(chunks).toHaveLength(1);
        expect(chunks[0]?.done).toBe(false);
    });

    it("textToSpeechStream exits silently when create throws after caller aborts", async () => {
        const controller = new AbortController();
        const client = {
            audio: {
                speech: {
                    create: vi.fn().mockImplementation(async () => {
                        controller.abort();
                        throw new Error("late failure");
                    })
                }
            }
        } as any;
        const cap = new OpenAIAudioTextToSpeechCapabilityImpl(makeProvider(), client);
        const chunks = await collect(cap.textToSpeechStream({ input: { text: "hello" } } as any, {} as any, controller.signal));
        expect(chunks).toEqual([]);
    });

    it("helper methods normalize URL and mime resolution", () => {
        const cap = new OpenAIAudioTextToSpeechCapabilityImpl(makeProvider(), {} as any);

        expect((cap as any).sanitizeOpenAITtsUrl("https://api.openai.com/v1/audio/speech")).toBeUndefined();
        expect((cap as any).sanitizeOpenAITtsUrl("https://cdn.example.com/a.mp3")).toBe("https://cdn.example.com/a.mp3");
        expect((cap as any).sanitizeOpenAITtsUrl("not-a-url")).toBeUndefined();
        expect((cap as any).sanitizeOpenAITtsUrl(undefined)).toBeUndefined();

        expect((cap as any).resolveAudioOutputMimeType("mp3", "audio/wav; charset=binary")).toBe("audio/wav");
        expect((cap as any).resolveAudioOutputMimeType("flac", null)).toBe("audio/flac");
        expect((cap as any).resolveAudioOutputMimeType("unknown", undefined)).toBe("audio/mpeg");
    });
});
