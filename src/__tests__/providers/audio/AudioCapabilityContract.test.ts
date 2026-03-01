import { describe, expect, it, vi } from "vitest";
import { OpenAIAudioCapabilityImpl } from "#root/providers/openai/capabilities/OpenAIAudioCapabilityImpl.js";
import { GeminiAudioCapabilityImpl } from "#root/providers/gemini/capabilities/GeminiAudioCapabilityImpl.js";

function makeProvider(defaults?: Record<string, unknown>) {
    return {
        ensureInitialized: vi.fn(),
        getMergedOptions: vi.fn((_capability: string, runtimeOptions: any) => ({
            model: runtimeOptions?.model,
            modelParams: {},
            providerParams: {},
            generalParams: {
                audioStreamBatchSize: 2,
                geminiTtsMaxAttempts: 1,
                geminiTtsRetryBaseMs: 0,
                geminiTtsRetryMaxMs: 0,
                geminiTtsRetryJitterRatio: 0,
                ...(defaults ?? {}),
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

describe("Audio capability cross-provider contract", () => {
    it("resolves input mime type consistently from filename hints in transcription", async () => {
        const openai = new OpenAIAudioCapabilityImpl(
            makeProvider(),
            {
                audio: {
                    transcriptions: {
                        create: vi.fn().mockResolvedValue({ text: "openai transcript" })
                    }
                }
            } as any
        );
        const gemini = new GeminiAudioCapabilityImpl(
            makeProvider(),
            {
                models: {
                    generateContent: vi.fn().mockResolvedValue({ text: "gemini transcript", responseId: "g1" })
                }
            } as any
        );

        const openaiRes = await openai.transcribeAudio({
            input: { file: "voice.ogg", filename: "voice.ogg" }
        } as any);
        const geminiRes = await gemini.transcribeAudio({
            input: { file: Buffer.from("abc"), filename: "voice.ogg" }
        } as any);

        expect(openaiRes.output[0]?.mimeType).toBe("audio/ogg");
        expect(geminiRes.output[0]?.mimeType).toBe("audio/ogg");
    });

    it("includes common audio metadata fields for non-stream TTS responses", async () => {
        const openai = new OpenAIAudioCapabilityImpl(
            makeProvider(),
            {
                audio: {
                    speech: {
                        create: vi.fn().mockResolvedValue({
                            arrayBuffer: vi.fn().mockResolvedValue(Uint8Array.from([1, 2, 3]).buffer),
                            headers: { get: vi.fn().mockReturnValue("audio/mpeg") }
                        })
                    }
                }
            } as any
        );
        const gemini = new GeminiAudioCapabilityImpl(
            makeProvider(),
            {
                models: {
                    generateContent: vi.fn().mockResolvedValue({
                        responseId: "tts1",
                        candidates: [
                            {
                                content: {
                                    parts: [{ inlineData: { mimeType: "audio/wav", data: "AQID" } }]
                                }
                            }
                        ]
                    })
                }
            } as any
        );

        const openaiRes = await openai.textToSpeech({ input: { text: "hello", format: "mp3" } } as any);
        const geminiRes = await gemini.textToSpeech({ input: { text: "hello", format: "wav" } } as any);

        for (const metadata of [openaiRes.metadata, geminiRes.metadata]) {
            expect(metadata?.audioRetryCount).toBeTypeOf("number");
            expect(metadata?.audioFallbackUsed).toBeTypeOf("boolean");
            expect(metadata?.audioSource).toBeTypeOf("string");
        }
    });

    it("enforces maxTtsOutputBytes for non-stream TTS across providers", async () => {
        const openai = new OpenAIAudioCapabilityImpl(
            makeProvider(),
            {
                audio: {
                    speech: {
                        create: vi.fn().mockResolvedValue({
                            arrayBuffer: vi.fn().mockResolvedValue(Uint8Array.from([1, 2, 3, 4]).buffer),
                            headers: { get: vi.fn().mockReturnValue("audio/mpeg") }
                        })
                    }
                }
            } as any
        );
        const gemini = new GeminiAudioCapabilityImpl(
            makeProvider(),
            {
                models: {
                    generateContent: vi.fn().mockResolvedValue({
                        responseId: "tts2",
                        candidates: [
                            {
                                content: {
                                    parts: [{ inlineData: { mimeType: "audio/wav", data: "AQIDBA==" } }]
                                }
                            }
                        ]
                    })
                }
            } as any
        );

        await expect(
            openai.textToSpeech({
                input: { text: "hello", format: "mp3" },
                options: { generalParams: { maxTtsOutputBytes: 2 } }
            } as any)
        ).rejects.toThrow("[AUDIO_OUTPUT_TOO_LARGE]");

        await expect(
            gemini.textToSpeech({
                input: { text: "hello", format: "wav" },
                options: { generalParams: { maxTtsOutputBytes: 2 } }
            } as any)
        ).rejects.toThrow("[AUDIO_OUTPUT_TOO_LARGE]");
    });

    it("surfaces audioErrorCode in stream terminal error chunks across providers", async () => {
        const openaiReader = {
            read: vi
                .fn()
                .mockResolvedValueOnce({ done: false, value: Uint8Array.from([1, 2, 3]) })
                .mockResolvedValueOnce({ done: true, value: undefined }),
            cancel: vi.fn().mockResolvedValue(undefined)
        };
        const openai = new OpenAIAudioCapabilityImpl(
            makeProvider(),
            {
                audio: {
                    speech: {
                        create: vi.fn().mockResolvedValue({
                            id: "o_stream_1",
                            headers: { get: vi.fn().mockReturnValue("audio/mpeg") },
                            body: { getReader: () => openaiReader }
                        })
                    }
                }
            } as any
        );

        const geminiStream = {
            async *[Symbol.asyncIterator]() {
                yield {
                    responseId: "g_stream_1",
                    candidates: [{ content: { parts: [{ inlineData: { mimeType: "audio/wav", data: "AQID" } }] } }]
                };
            }
        };
        const gemini = new GeminiAudioCapabilityImpl(
            makeProvider(),
            {
                models: {
                    generateContentStream: vi.fn().mockResolvedValue(geminiStream),
                    generateContent: vi.fn()
                }
            } as any
        );

        const openaiChunks = await collect(
            openai.textToSpeechStream({
                input: { text: "hello", format: "mp3" },
                options: { generalParams: { maxTtsOutputBytes: 2 } }
            } as any)
        );
        const geminiChunks = await collect(
            gemini.textToSpeechStream({
                input: { text: "hello", format: "wav" },
                options: { generalParams: { maxTtsOutputBytes: 2 } }
            } as any)
        );

        expect(openaiChunks.at(-1)?.done).toBe(true);
        expect(openaiChunks.at(-1)?.metadata?.audioErrorCode).toBe("AUDIO_OUTPUT_TOO_LARGE");
        expect(geminiChunks.at(-1)?.done).toBe(true);
        expect(geminiChunks.at(-1)?.metadata?.audioErrorCode).toBe("AUDIO_OUTPUT_TOO_LARGE");
    });
});
