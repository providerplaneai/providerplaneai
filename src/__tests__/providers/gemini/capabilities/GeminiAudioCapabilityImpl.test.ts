import { describe, expect, it, vi } from "vitest";
import { GeminiAudioCapabilityImpl } from "#root/providers/gemini/capabilities/GeminiAudioCapabilityImpl.js";

function makeProvider() {
    return {
        ensureInitialized: vi.fn(),
        getMergedOptions: vi.fn((_capability: string, runtimeOptions: any) => ({
            model: runtimeOptions?.model,
            modelParams: {},
            providerParams: {},
            generalParams: {
                audioStreamBatchSize: 3,
                geminiTtsMaxAttempts: 3,
                geminiTtsRetryBaseMs: 0,
                geminiTtsRetryMaxMs: 0,
                geminiTtsRetryJitterRatio: 0,
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

describe("GeminiAudioCapabilityImpl", () => {
    it("transcribeAudio validates file input", async () => {
        const cap = new GeminiAudioCapabilityImpl(makeProvider(), { models: {} } as any);
        await expect(cap.transcribeAudio({ input: {} } as any)).rejects.toThrow("Audio transcription requires an input file");
    });

    it("transcribeAudio rejects string inputs that are not data URLs", async () => {
        const cap = new GeminiAudioCapabilityImpl(
            makeProvider(),
            { models: { generateContent: vi.fn() } } as any
        );

        await expect(
            cap.transcribeAudio({
                input: { file: "relative/path/to/audio.wav" }
            } as any)
        ).rejects.toThrow("[AUDIO_UNSUPPORTED_INPUT]");
    });

    it("transcribeAudio maps transcript + metadata", async () => {
        const client = {
            models: {
                generateContent: vi.fn().mockResolvedValue({
                    text: "hello transcript",
                    responseId: "r1",
                    usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 3, totalTokenCount: 5 }
                })
            }
        };

        const cap = new GeminiAudioCapabilityImpl(makeProvider(), client as any);
        const res = await cap.transcribeAudio({
            input: { file: Buffer.from("abc"), filename: "clip.wav", mimeType: "audio/wav" },
            context: { requestId: "req1", metadata: { trace: "t" } }
        } as any);

        expect(res.output[0]?.kind).toBe("transcription");
        expect(res.output[0]?.transcript).toBe("hello transcript");
        expect(res.output[0]?.mimeType).toBe("audio/wav");
        expect(res.output[0]?.id).toBe("r1");
        expect(res.id).toBe("r1");
        expect(res.metadata?.provider).toBe("gemini");
        expect(res.metadata?.totalTokens).toBe(5);
    });

    it("transcribeAudioStream emits deltas and final chunk", async () => {
        const stream = {
            async *[Symbol.asyncIterator]() {
                yield { text: "he", responseId: "s1" };
                yield { text: "llo", responseId: "s1" };
            }
        };
        const client = {
            models: {
                generateContentStream: vi.fn().mockResolvedValue(stream)
            }
        };
        const cap = new GeminiAudioCapabilityImpl(makeProvider(), client as any);

        const chunks = await collect(
            cap.transcribeAudioStream({
                input: { file: Buffer.from("abc"), filename: "clip.mp3", mimeType: "audio/mpeg" },
                context: { requestId: "req-stream" }
            } as any)
        );

        expect(chunks.length).toBeGreaterThanOrEqual(2);
        expect(chunks[0]?.output).toBeUndefined();
        expect(chunks.at(-1)?.done).toBe(true);
        expect(chunks.at(-1)?.output?.[0]?.transcript).toBe("hello");
    });

    it("transcribeAudioStream parses audio error code from generic error message", async () => {
        const client = {
            models: {
                generateContentStream: vi.fn().mockRejectedValue(new Error("[AUDIO_INVALID_PAYLOAD] bad stream response"))
            }
        };
        const cap = new GeminiAudioCapabilityImpl(makeProvider(), client as any);
        const chunks = await collect(
            cap.transcribeAudioStream({
                input: { file: Buffer.from("abc"), filename: "clip.wav", mimeType: "audio/wav" }
            } as any)
        );

        expect(chunks.at(-1)?.done).toBe(true);
        expect(chunks.at(-1)?.metadata?.audioErrorCode).toBe("AUDIO_INVALID_PAYLOAD");
    });

    it("translateAudio returns normalized translated transcript", async () => {
        const client = {
            models: {
                generateContent: vi.fn().mockResolvedValue({
                    text: "translated output",
                    responseId: "r2"
                })
            }
        };
        const cap = new GeminiAudioCapabilityImpl(makeProvider(), client as any);
        const res = await cap.translateAudio({
            input: { file: Buffer.from("abc"), targetLanguage: "en" }
        } as any);

        expect(res.output[0]?.kind).toBe("translation");
        expect(res.output[0]?.transcript).toBe("translated output");
        expect(res.output[0]?.language).toBe("en");
    });

    it("textToSpeech maps Gemini inline audio to normalized artifact", async () => {
        const client = {
            models: {
                generateContent: vi.fn().mockResolvedValue({
                    responseId: "tts1",
                    candidates: [
                        {
                            content: {
                                parts: [
                                    {
                                        inlineData: { mimeType: "audio/wav", data: "AQID" },
                                        fileData: { fileUri: "https://cdn.example.com/gemini-audio.wav" }
                                    }
                                ]
                            }
                        }
                    ]
                })
            }
        };
        const cap = new GeminiAudioCapabilityImpl(makeProvider(), client as any);
        const res = await cap.textToSpeech({
            input: { text: "hello", format: "wav", voice: "Kore" }
        } as any);

        expect(res.output[0]?.kind).toBe("tts");
        expect(res.output[0]?.base64).toBe("AQID");
        expect(res.output[0]?.url).toBe("https://cdn.example.com/gemini-audio.wav");
    });

    it("textToSpeech returns AUDIO_INVALID_PAYLOAD when provider audio payload is malformed", async () => {
        const client = {
            models: {
                generateContent: vi.fn().mockResolvedValue({
                    responseId: "tts_bad_base64",
                    candidates: [
                        {
                            content: {
                                parts: [{ inlineData: { mimeType: "audio/wav", data: "%%invalid%%" } }]
                            }
                        }
                    ]
                })
            }
        };

        const cap = new GeminiAudioCapabilityImpl(makeProvider(), client as any);
        await expect(cap.textToSpeech({ input: { text: "hello", format: "wav" } } as any)).rejects.toThrow(
            "[AUDIO_INVALID_PAYLOAD]"
        );
    });

    it("textToSpeech wraps PCM/L16 into wav when wav is requested", async () => {
        const client = {
            models: {
                generateContent: vi.fn().mockResolvedValue({
                    responseId: "tts_pcm",
                    candidates: [
                        {
                            content: {
                                parts: [{ inlineData: { mimeType: "audio/L16;rate=24000", data: "AQIDBA==" } }]
                            }
                        }
                    ]
                })
            }
        };
        const cap = new GeminiAudioCapabilityImpl(makeProvider(), client as any);
        const res = await cap.textToSpeech({
            input: { text: "hello", format: "wav" }
        } as any);

        const bytes = Buffer.from(res.output[0]?.base64 ?? "", "base64");
        expect(bytes.subarray(0, 4).toString("ascii")).toBe("RIFF");
        expect(bytes.subarray(8, 12).toString("ascii")).toBe("WAVE");
        expect(res.output[0]?.mimeType).toBe("audio/wav");
    });

    it("textToSpeech retries when Gemini returns non-audio response first", async () => {
        const generateContent = vi
            .fn()
            .mockResolvedValueOnce({
                responseId: "tts_no_audio",
                text: "temporary no audio response",
                candidates: [{ content: { parts: [{ text: "temporary no audio response" }] } }]
            })
            .mockResolvedValueOnce({
                responseId: "tts_audio",
                candidates: [
                    {
                        content: {
                            parts: [{ inlineData: { mimeType: "audio/wav", data: "AQID" } }]
                        }
                    }
                ]
            });

        const client = { models: { generateContent } };
        const cap = new GeminiAudioCapabilityImpl(makeProvider(), client as any);
        const res = await cap.textToSpeech({
            input: { text: "hello", format: "wav" }
        } as any);

        expect(generateContent).toHaveBeenCalledTimes(2);
        expect(res.output[0]?.base64).toBe("AQID");
        expect(res.metadata?.audioRetryCount).toBe(1);
        expect(res.metadata?.audioSource).toBe("gemini-generateContent");
    });

    it("textToSpeech extracts audio from non-first candidate", async () => {
        const client = {
            models: {
                generateContent: vi.fn().mockResolvedValue({
                    responseId: "tts_cands",
                    candidates: [
                        { content: { parts: [{ text: "text-only candidate" }] } },
                        { content: { parts: [{ inlineData: { mimeType: "audio/wav", data: "AQID" } }] } }
                    ]
                })
            }
        };
        const cap = new GeminiAudioCapabilityImpl(makeProvider(), client as any);
        const res = await cap.textToSpeech({ input: { text: "hello", format: "wav" } } as any);

        expect(res.output[0]?.base64).toBe("AQID");
        expect(res.output[0]?.mimeType).toBe("audio/wav");
    });

    it("textToSpeech falls back to stream generation when retries contain no audio", async () => {
        const generateContent = vi.fn().mockResolvedValue({
            responseId: "tts_no_audio",
            text: "still no audio",
            candidates: [{ content: { parts: [{ text: "still no audio" }] } }]
        });
        const stream = {
            async *[Symbol.asyncIterator]() {
                yield {
                    responseId: "tts_stream_fallback",
                    candidates: [{ content: { parts: [{ inlineData: { mimeType: "audio/wav", data: "AQID" } }] } }]
                };
            }
        };
        const generateContentStream = vi.fn().mockResolvedValue(stream);

        const cap = new GeminiAudioCapabilityImpl(
            makeProvider(),
            { models: { generateContent, generateContentStream } } as any
        );
        const res = await cap.textToSpeech({ input: { text: "hello", format: "wav" } } as any);

        expect(generateContent).toHaveBeenCalledTimes(3);
        expect(generateContentStream).toHaveBeenCalledTimes(1);
        expect(res.output[0]?.base64).toBe("AQID");
        expect(res.metadata?.audioFallbackUsed).toBe(true);
        expect(res.metadata?.audioSource).toBe("gemini-generateContentStream-fallback");
    });

    it("textToSpeechStream emits audio deltas and final output", async () => {
        const stream = {
            async *[Symbol.asyncIterator]() {
                yield {
                    responseId: "stts",
                    candidates: [{ content: { parts: [{ inlineData: { mimeType: "audio/L16;rate=24000", data: "AQ==" } }] } }]
                };
                yield {
                    responseId: "stts",
                    candidates: [{ content: { parts: [{ inlineData: { mimeType: "audio/L16;rate=24000", data: "Ag==" } }] } }]
                };
            }
        };
        const client = {
            models: {
                generateContentStream: vi.fn().mockResolvedValue(stream),
                generateContent: vi.fn()
            }
        };
        const cap = new GeminiAudioCapabilityImpl(makeProvider(), client as any);
        const chunks = await collect(cap.textToSpeechStream({ input: { text: "hello", format: "wav" } } as any));

        expect(chunks[0]?.done).toBe(false);
        expect(chunks[0]?.delta?.[0]?.base64).toBe("AQ==");
        expect(chunks[1]?.delta?.[0]?.base64).toBe("Ag==");
        expect(chunks.at(-1)?.done).toBe(true);
        const bytes = Buffer.from(chunks.at(-1)?.output?.[0]?.base64 ?? "", "base64");
        expect(bytes.subarray(0, 4).toString("ascii")).toBe("RIFF");
        expect(chunks.at(-1)?.output?.[0]?.mimeType).toBe("audio/wav");
    });

    it("textToSpeechStream emits structured error when stream audio payload is malformed", async () => {
        const stream = {
            async *[Symbol.asyncIterator]() {
                yield {
                    responseId: "stts_bad",
                    candidates: [
                        { content: { parts: [{ inlineData: { mimeType: "audio/wav", data: "%%invalid%%" } }] } }
                    ]
                };
            }
        };
        const client = {
            models: {
                generateContentStream: vi.fn().mockResolvedValue(stream),
                generateContent: vi.fn()
            }
        };
        const cap = new GeminiAudioCapabilityImpl(makeProvider(), client as any);
        const chunks = await collect(cap.textToSpeechStream({ input: { text: "hello", format: "wav" } } as any));

        expect(chunks.at(-1)?.done).toBe(true);
        expect(chunks.at(-1)?.error).toContain("[AUDIO_INVALID_PAYLOAD]");
        expect(chunks.at(-1)?.metadata?.audioErrorCode).toBe("AUDIO_INVALID_PAYLOAD");
    });

    it("textToSpeechStream emits terminal error after partial valid output when a later chunk is malformed", async () => {
        const stream = {
            async *[Symbol.asyncIterator]() {
                yield {
                    responseId: "stts_partial_bad",
                    candidates: [{ content: { parts: [{ inlineData: { mimeType: "audio/wav", data: "AQ==" } }] } }]
                };
                yield {
                    responseId: "stts_partial_bad",
                    candidates: [{ content: { parts: [{ inlineData: { mimeType: "audio/wav", data: "%%bad%%" } }] } }]
                };
            }
        };
        const client = {
            models: {
                generateContentStream: vi.fn().mockResolvedValue(stream),
                generateContent: vi.fn()
            }
        };

        const cap = new GeminiAudioCapabilityImpl(makeProvider(), client as any);
        const chunks = await collect(cap.textToSpeechStream({ input: { text: "hello", format: "wav" } } as any));

        expect(chunks[0]?.done).toBe(false);
        expect(chunks[0]?.delta?.[0]?.base64).toBe("AQ==");
        expect(chunks.at(-1)?.done).toBe(true);
        expect(chunks.at(-1)?.metadata?.audioErrorCode).toBe("AUDIO_INVALID_PAYLOAD");
    });

    it("textToSpeechStream stops cleanly when aborted during retry backoff before stream fallback", async () => {
        vi.useFakeTimers();
        try {
            const emptyStream = {
                async *[Symbol.asyncIterator]() {
                    yield { responseId: "empty", candidates: [{ content: { parts: [{ text: "no audio yet" }] } }] };
                }
            };
            const generateContentStream = vi.fn().mockResolvedValue(emptyStream);
            const cap = new GeminiAudioCapabilityImpl(
                makeProvider(),
                {
                    models: {
                        generateContentStream,
                        generateContent: vi.fn()
                    }
                } as any
            );

            const abortController = new AbortController();
            const chunksPromise = collect(
                cap.textToSpeechStream(
                    {
                        input: { text: "hello", format: "wav" },
                        options: {
                            generalParams: {
                                geminiTtsMaxAttempts: 3,
                                geminiTtsRetryBaseMs: 100,
                                geminiTtsRetryMaxMs: 100,
                                geminiTtsRetryJitterRatio: 0
                            }
                        }
                    } as any,
                    undefined,
                    abortController.signal
                )
            );

            abortController.abort();
            await vi.runAllTimersAsync();
            const chunks = await chunksPromise;

            expect(chunks).toHaveLength(0);
            expect(generateContentStream).toHaveBeenCalledTimes(1);
        } finally {
            vi.useRealTimers();
        }
    });

    it("normalizeAudioInput handles Uint8Array, ArrayBuffer, File-like, stream, and unsupported object", async () => {
        const cap = new GeminiAudioCapabilityImpl(makeProvider(), { models: {} } as any);
        const internal = cap as any;

        const fromUint8 = await internal.normalizeAudioInput(new Uint8Array([1, 2, 3]), "audio/wav");
        expect(fromUint8.base64).toBe("AQID");
        expect(fromUint8.mimeType).toBe("audio/wav");

        const fromArrayBuffer = await internal.normalizeAudioInput(Uint8Array.from([4, 5]).buffer, "audio/wav");
        expect(fromArrayBuffer.base64).toBe("BAU=");

        const fromFileLike = await internal.normalizeAudioInput(
            {
                async arrayBuffer() {
                    return Uint8Array.from([6, 7]).buffer;
                }
            },
            "audio/wav"
        );
        expect(fromFileLike.base64).toBe("Bgc=");

        const stream = {
            async *[Symbol.asyncIterator]() {
                yield "a";
                yield Uint8Array.from([98]); // "b"
                yield Buffer.from([99]); // "c"
            }
        };
        const fromStream = await internal.normalizeAudioInput(stream, "audio/wav");
        expect(Buffer.from(fromStream.base64, "base64").toString("utf8")).toBe("abc");

        await expect(internal.normalizeAudioInput({ not: "supported" }, "audio/wav")).rejects.toThrow(
            "[AUDIO_UNSUPPORTED_INPUT]"
        );
    });

    it("normalizeAudioInput handles valid/invalid data URLs", async () => {
        const cap = new GeminiAudioCapabilityImpl(makeProvider(), { models: {} } as any);
        const internal = cap as any;

        const fromDataUrl = await internal.normalizeAudioInput("data:audio/wav;base64,AQID", undefined, "x.wav");
        expect(fromDataUrl.base64).toBe("AQID");
        expect(fromDataUrl.mimeType).toBe("audio/wav");

        const withExplicit = await internal.normalizeAudioInput("data:audio/mpeg;base64,AQID", "audio/flac", "x.mp3");
        expect(withExplicit.mimeType).toBe("audio/flac");

        await expect(internal.normalizeAudioInput("data:audio/wav;base64", undefined, "x.wav")).rejects.toThrow(
            "[AUDIO_INVALID_PAYLOAD]"
        );
    });

    it("textToSpeech aborts between retry attempts and fallback when signal is set after first attempt", async () => {
        const abortController = new AbortController();
        const generateContent = vi.fn().mockImplementationOnce(async () => {
            abortController.abort("stop");
            return { responseId: "tts_abort_mid", candidates: [{ content: { parts: [{ text: "no audio" }] } }] };
        });

        const cap = new GeminiAudioCapabilityImpl(
            makeProvider(),
            { models: { generateContent, generateContentStream: vi.fn() } } as any
        );

        await expect(
            cap.textToSpeech(
                {
                    input: { text: "hello", format: "wav" },
                    options: { generalParams: { geminiTtsMaxAttempts: 1 } }
                } as any,
                undefined,
                abortController.signal
            )
        ).rejects.toThrow("[AUDIO_REQUEST_ABORTED]");
    });

    it("delayWithBackoff resolves immediately for zero durations and rejects on pre-aborted signal", async () => {
        const cap = new GeminiAudioCapabilityImpl(makeProvider(), { models: {} } as any);
        const internal = cap as any;

        await expect(internal.delayWithBackoff(1, 0, 0, 0)).resolves.toBeUndefined();

        const abortController = new AbortController();
        abortController.abort();
        await expect(internal.delayWithBackoff(1, 10, 10, 0, abortController.signal)).rejects.toThrow(
            "[AUDIO_REQUEST_ABORTED]"
        );
    });

    it("delayWithBackoff resolves on timer completion with active signal", async () => {
        vi.useFakeTimers();
        try {
            const cap = new GeminiAudioCapabilityImpl(makeProvider(), { models: {} } as any);
            const internal = cap as any;
            const abortController = new AbortController();

            const pending = internal.delayWithBackoff(1, 5, 5, 0, abortController.signal);
            await vi.advanceTimersByTimeAsync(5);
            await expect(pending).resolves.toBeUndefined();
        } finally {
            vi.useRealTimers();
        }
    });

    it("internal helper methods normalize payloads and metadata branches", async () => {
        const cap = new GeminiAudioCapabilityImpl(makeProvider(), { models: {} } as any);
        const internal = cap as any;

        expect(internal.stripModelPrefix("models/gemini-2.5-flash")).toBe("gemini-2.5-flash");
        expect(internal.stripModelPrefix("gemini-2.5-flash")).toBe("gemini-2.5-flash");

        expect(internal.buildSpeechConfig().voiceConfig.prebuiltVoiceConfig.voiceName).toBeTruthy();
        expect(internal.buildSpeechConfig("Aoede").voiceConfig.prebuiltVoiceConfig.voiceName).toBe("Aoede");

        const contents = internal.buildAudioContents("prompt", { base64: "AQID", mimeType: "audio/wav" });
        expect(contents[0]?.parts?.[0]?.text).toBe("prompt");
        expect(contents[0]?.parts?.[1]?.inlineData?.mimeType).toBe("audio/wav");

        expect(internal.extractUsage(undefined)).toEqual({});
        expect(
            internal.extractUsage({
                usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 2, totalTokenCount: 3 }
            })
        ).toEqual({ inputTokens: 1, outputTokens: 2, totalTokens: 3 });

        expect(internal.extractGeminiText({ text: "direct" })).toBe("direct");
        expect(
            internal.extractGeminiText({
                candidates: [{ content: { parts: [{ text: "a" }, { text: "b" }, { inlineData: { data: "AQ==" } }] } }]
            })
        ).toBe("ab");
        expect(internal.extractGeminiText({ candidates: [{ content: {} }] })).toBe("");

        expect(
            internal.extractGeminiAudioPart({
                candidates: [{ content: { parts: [{ inlineData: { mimeType: "audio/wav", data: "AQ==", url: "https://cdn.example.com/a.wav" } }] } }]
            })
        ).toEqual({ data: "AQ==", mimeType: "audio/wav", url: "https://cdn.example.com/a.wav" });

        expect(
            internal.extractGeminiAudioPart({
                response: {
                    candidates: [
                        { content: { parts: [{ inline_data: { mime_type: "audio/wav", data: "Ag==" }, file_data: { file_uri: "https://cdn.example.com/b.wav" } }] } }
                    ]
                }
            })
        ).toEqual({ data: "Ag==", mimeType: "audio/wav", url: "https://cdn.example.com/b.wav" });

        // Non-http URLs are intentionally dropped from normalized output.
        expect(
            internal.extractGeminiAudioPart({
                candidates: [{ content: { parts: [{ inlineData: { mimeType: "audio/wav", data: "AQ==", url: "gs://bucket/a.wav" } }] } }]
            })
        ).toEqual({ data: "AQ==", mimeType: "audio/wav", url: undefined });

        expect(internal.extractGeminiAudioPart({ candidates: [{ content: { parts: [{ text: "no-audio" }] } }] })).toBeUndefined();

        const extracted = await internal.extractGeminiAudioFromStreamResult({
            response: Promise.resolve({
                candidates: [{ content: { parts: [{ inlineData: { mimeType: "audio/wav", data: "AQID" } }] } }]
            })
        });
        expect(extracted?.data).toBe("AQID");

        const none = await internal.extractGeminiAudioFromStreamResult({
            response: Promise.reject(new Error("no response")),
            finalResponse: undefined,
            result: undefined
        });
        expect(none).toBeUndefined();
    });

    it("generateTtsFromStreamFallback helper returns undefined/rethrows across error branches", async () => {
        const capNoAudio = new GeminiAudioCapabilityImpl(
            makeProvider(),
            {
                models: {
                    generateContentStream: vi.fn().mockResolvedValue({
                        async *[Symbol.asyncIterator]() {
                            yield { candidates: [{ content: { parts: [{ text: "no audio" }] } }] };
                        }
                    })
                }
            } as any
        );
        const helperNoAudio = (capNoAudio as any).generateTtsFromStreamFallback.bind(capNoAudio as any);
        const noAudio = await helperNoAudio({ model: "x", contents: [], config: {} });
        expect(noAudio).toBeUndefined();

        const capThrows = new GeminiAudioCapabilityImpl(
            makeProvider(),
            {
                models: {
                    generateContentStream: vi.fn().mockRejectedValue(new Error("provider stream error"))
                }
            } as any
        );
        const helperThrows = (capThrows as any).generateTtsFromStreamFallback.bind(capThrows as any);
        const swallowed = await helperThrows({ model: "x", contents: [], config: {} });
        expect(swallowed).toBeUndefined();

        const capAbort = new GeminiAudioCapabilityImpl(
            makeProvider(),
            {
                models: {
                    generateContentStream: vi.fn().mockResolvedValue({
                        async *[Symbol.asyncIterator]() {
                            yield { candidates: [{ content: { parts: [{ text: "no audio" }] } }] };
                        }
                    })
                }
            } as any
        );
        const helperAbort = (capAbort as any).generateTtsFromStreamFallback.bind(capAbort as any);
        const abortController = new AbortController();
        abortController.abort("stop");
        await expect(
            helperAbort({ model: "x", contents: [], config: {} }, abortController.signal)
        ).rejects.toThrow("[AUDIO_REQUEST_ABORTED]");
    });

    it("textToSpeechStream retries stream attempts when no audio chunks are emitted", async () => {
        const emptyStream = {
            async *[Symbol.asyncIterator]() {
                yield { responseId: "try1", candidates: [{ content: { parts: [{ text: "no audio" }] } }] };
            }
        };
        const goodStream = {
            async *[Symbol.asyncIterator]() {
                yield {
                    responseId: "try2",
                    candidates: [{ content: { parts: [{ inlineData: { mimeType: "audio/wav", data: "AQID" } }] } }]
                };
            }
        };

        const generateContentStream = vi.fn().mockResolvedValueOnce(emptyStream).mockResolvedValueOnce(goodStream);
        const cap = new GeminiAudioCapabilityImpl(
            makeProvider(),
            {
                models: {
                    generateContentStream,
                    generateContent: vi.fn()
                }
            } as any
        );

        const chunks = await collect(cap.textToSpeechStream({ input: { text: "hello", format: "wav" } } as any));
        expect(generateContentStream).toHaveBeenCalledTimes(2);
        expect(chunks.at(-1)?.done).toBe(true);
        expect(chunks.at(-1)?.output?.[0]?.base64).toBe("AQID");
    });

    it("textToSpeechStream can use stream response payload when iterator has no audio chunks", async () => {
        const streamWithResponse = {
            async *[Symbol.asyncIterator]() {
                yield { responseId: "s-final", candidates: [{ content: { parts: [{ text: "prelude" }] } }] };
            },
            response: Promise.resolve({
                responseId: "s-final",
                candidates: [{ content: { parts: [{ inlineData: { mimeType: "audio/wav", data: "AQID" } }] } }]
            })
        };
        const generateContentStream = vi.fn().mockResolvedValue(streamWithResponse);
        const cap = new GeminiAudioCapabilityImpl(
            makeProvider(),
            {
                models: {
                    generateContentStream,
                    generateContent: vi.fn()
                }
            } as any
        );

        const chunks = await collect(cap.textToSpeechStream({ input: { text: "hello", format: "wav" } } as any));
        expect(generateContentStream).toHaveBeenCalledTimes(1);
        expect(chunks.at(-1)?.done).toBe(true);
        expect(chunks.at(-1)?.output?.[0]?.base64).toBe("AQID");
        expect(chunks.at(-1)?.metadata?.audioSource).toBe("gemini-generateContentStream.response");
    });

    it("textToSpeechStream returns structured error code when maxTtsOutputBytes is exceeded", async () => {
        const stream = {
            async *[Symbol.asyncIterator]() {
                yield {
                    responseId: "limit",
                    candidates: [{ content: { parts: [{ inlineData: { mimeType: "audio/wav", data: "AQIDBA==" } }] } }]
                };
            }
        };

        const cap = new GeminiAudioCapabilityImpl(
            makeProvider(),
            {
                models: {
                    generateContentStream: vi.fn().mockResolvedValue(stream),
                    generateContent: vi.fn()
                }
            } as any
        );

        const chunks = await collect(
            cap.textToSpeechStream({
                input: { text: "hello", format: "wav" },
                options: { generalParams: { maxTtsOutputBytes: 2 } }
            } as any)
        );
        expect(chunks.at(-1)?.done).toBe(true);
        expect(chunks.at(-1)?.error).toContain("[AUDIO_OUTPUT_TOO_LARGE]");
        expect(chunks.at(-1)?.metadata?.audioErrorCode).toBe("AUDIO_OUTPUT_TOO_LARGE");
    });
});
