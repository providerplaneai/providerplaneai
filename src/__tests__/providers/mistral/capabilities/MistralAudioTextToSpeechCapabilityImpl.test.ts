import { describe, expect, it, vi } from "vitest";
import { MistralAudioTextToSpeechCapabilityImpl } from "#root/providers/mistral/capabilities/MistralAudioTextToSpeechCapabilityImpl.js";

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

describe("MistralAudioTextToSpeechCapabilityImpl", () => {
    it("textToSpeech rejects when aborted before execution", async () => {
        const cap = new MistralAudioTextToSpeechCapabilityImpl(makeProvider(), {} as any);
        const ac = new AbortController();
        ac.abort();
        await expect(cap.textToSpeech({ input: { text: "hello", voice: "voice-1" } } as any, {} as any, ac.signal)).rejects.toThrow(
            "Text-to-speech request aborted before execution"
        );
    });

    it("textToSpeech validates non-empty text", async () => {
        const cap = new MistralAudioTextToSpeechCapabilityImpl(makeProvider(), {} as any);
        await expect(cap.textToSpeech({ input: { text: "   ", voice: "voice-1" } } as any, {} as any)).rejects.toThrow(
            "TTS text must be a non-empty string"
        );
    });

    it("textToSpeech requires voice or refAudio", async () => {
        const cap = new MistralAudioTextToSpeechCapabilityImpl(makeProvider(), {} as any);
        await expect(cap.textToSpeech({ input: { text: "hello" } } as any, {} as any)).rejects.toThrow(
            "Mistral TTS requires request.voice, modelParams.voiceId, or modelParams.refAudio"
        );
    });

    it("textToSpeech validates supported formats", async () => {
        const cap = new MistralAudioTextToSpeechCapabilityImpl(makeProvider(), {} as any);
        await expect(cap.textToSpeech({ input: { text: "hello", voice: "voice-1", format: "aac" } } as any, {} as any)).rejects.toThrow(
            "Unsupported Mistral TTS format: aac"
        );
    });

    it("textToSpeech maps base64 payload to normalized artifact", async () => {
        const complete = vi.fn().mockResolvedValue({ audioData: "AQID" });
        const cap = new MistralAudioTextToSpeechCapabilityImpl(makeProvider(), {
            audio: { speech: { complete } }
        } as any);

        const res = await cap.textToSpeech(
            {
                input: { text: "hello", voice: "voice-1", format: "mp3" },
                context: { requestId: "mistral-tts-1" }
            } as any,
            {} as any
        );

        expect(res.id).toBe("mistral-tts-1");
        expect(res.output[0]?.base64).toBe("AQID");
        expect(res.output[0]?.mimeType).toBe("audio/mpeg");
        expect(complete).toHaveBeenCalledWith(
            expect.objectContaining({
                voiceId: "voice-1",
                responseFormat: "mp3",
                stream: false
            }),
            expect.any(Object)
        );
    });

    it("textToSpeech accepts project-level voiceId and refAudio config", async () => {
        const provider = makeProvider();
        provider.getMergedOptions = vi.fn().mockReturnValue({
            model: "voxtral-mini-tts-2603",
            modelParams: { voiceId: "config-voice-id", refAudio: "ref-audio-id" },
            providerParams: { timeout: 30_000 },
            generalParams: {}
        });
        const complete = vi.fn().mockResolvedValue({ audioData: "AQID" });
        const cap = new MistralAudioTextToSpeechCapabilityImpl(provider, {
            audio: { speech: { complete } }
        } as any);

        await cap.textToSpeech({ input: { text: "hello from config" } } as any, {} as any);

        expect(complete).toHaveBeenCalledWith(
            expect.objectContaining({
                voiceId: "config-voice-id",
                refAudio: "ref-audio-id"
            }),
            expect.objectContaining({ timeout: 30_000 })
        );
    });

    it("textToSpeechStream emits deltas and final artifact", async () => {
        const stream = {
            async *[Symbol.asyncIterator]() {
                yield {
                    event: "speech.audio.delta",
                    data: { type: "speech.audio.delta", audioData: Buffer.from("ab").toString("base64") }
                };
                yield {
                    event: "speech.audio.delta",
                    data: { type: "speech.audio.delta", audioData: Buffer.from("cd").toString("base64") }
                };
                yield {
                    event: "speech.audio.done",
                    data: { type: "speech.audio.done", usage: { totalTokens: 4 } }
                };
            }
        };

        const cap = new MistralAudioTextToSpeechCapabilityImpl(makeProvider(), {
            audio: { speech: { complete: vi.fn().mockResolvedValue(stream) } }
        } as any);

        const chunks = await collect(
            cap.textToSpeechStream(
                {
                    input: { text: "hello", voice: "voice-1", format: "wav" },
                    context: { requestId: "mistral-tts-stream-1" }
                } as any,
                {} as any
            )
        );

        expect(chunks).toHaveLength(3);
        expect(chunks[0]?.done).toBe(false);
        expect(chunks[0]?.delta?.[0]?.mimeType).toBe("audio/wav");
        expect(chunks[2]?.done).toBe(true);
        expect(chunks[2]?.output?.[0]?.base64).toBe(Buffer.from("abcd").toString("base64"));
        expect(chunks[2]?.metadata?.totalTokens).toBe(4);
    });

    it("textToSpeechStream rejects non-stream responses on stream path", async () => {
        const cap = new MistralAudioTextToSpeechCapabilityImpl(makeProvider(), {
            audio: { speech: { complete: vi.fn().mockResolvedValue({ audioData: "AQID" }) } }
        } as any);

        await expect(
            collect(cap.textToSpeechStream({ input: { text: "hello", voice: "voice-1" } } as any, {} as any))
        ).rejects.toThrow("Mistral TTS stream returned a non-streaming response");
    });

    it("textToSpeech rejects stream responses on non-stream path", async () => {
        const cap = new MistralAudioTextToSpeechCapabilityImpl(makeProvider(), {
            audio: {
                speech: {
                    complete: vi.fn().mockResolvedValue(
                        (async function* () {
                            yield {
                                event: "speech.audio.done",
                                data: { type: "speech.audio.done", usage: { totalTokens: 1 } }
                            };
                        })()
                    )
                }
            }
        } as any);

        await expect(cap.textToSpeech({ input: { text: "hello", voice: "voice-1" } } as any, {} as any)).rejects.toThrow(
            "Mistral TTS returned a streaming response for a non-streaming request"
        );
    });

    it("textToSpeechStream exits quietly on abort", async () => {
        const controller = new AbortController();
        const stream = {
            async *[Symbol.asyncIterator]() {
                yield {
                    event: "speech.audio.delta",
                    data: { type: "speech.audio.delta", audioData: Buffer.from("ab").toString("base64") }
                };
                controller.abort();
                yield {
                    event: "speech.audio.delta",
                    data: { type: "speech.audio.delta", audioData: Buffer.from("cd").toString("base64") }
                };
            }
        };

        const cap = new MistralAudioTextToSpeechCapabilityImpl(makeProvider(), {
            audio: { speech: { complete: vi.fn().mockResolvedValue(stream) } }
        } as any);

        const chunks = await collect(
            cap.textToSpeechStream({ input: { text: "hello", voice: "voice-1" } } as any, {} as any, controller.signal)
        );

        expect(chunks).toHaveLength(1);
        expect(chunks[0]?.done).toBe(false);
    });
});
