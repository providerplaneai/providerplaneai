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
    it("textToSpeech validates non-empty text", async () => {
        const cap = new OpenAIAudioTextToSpeechCapabilityImpl(makeProvider(), {} as any);
        await expect(cap.textToSpeech({ input: { text: "   " } } as any, {} as any)).rejects.toThrow(
            "TTS text must be a non-empty string"
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

    it("textToSpeechStream rejects unsupported sse format", async () => {
        const cap = new OpenAIAudioTextToSpeechCapabilityImpl(makeProvider(), {} as any);
        await expect(
            collect(cap.textToSpeechStream({ input: { text: "hello", streamFormat: "sse" } } as any, {} as any))
        ).rejects.toThrow("SSE stream format is not supported yet");
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
});
