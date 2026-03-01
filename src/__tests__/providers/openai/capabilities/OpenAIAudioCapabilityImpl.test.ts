import { describe, expect, it, vi } from "vitest";
import { OpenAIAudioCapabilityImpl } from "#root/providers/openai/capabilities/OpenAIAudioCapabilityImpl.js";

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

describe("OpenAIAudioCapabilityImpl", () => {
    async function collect<T>(iter: AsyncGenerator<T>): Promise<T[]> {
        const out: T[] = [];
        for await (const item of iter) {
            out.push(item);
        }
        return out;
    }

    it("transcribeAudio validates file input", async () => {
        const provider = makeProvider();
        const cap = new OpenAIAudioCapabilityImpl(provider, { audio: { transcriptions: {} } } as any);
        await expect(cap.transcribeAudio({ input: {} } as any)).rejects.toThrow("Audio transcription requires an input file");
    });

    it("translateAudio validates file input and target language", async () => {
        const provider = makeProvider();
        const cap = new OpenAIAudioCapabilityImpl(provider, { audio: { translations: {} } } as any);

        await expect(cap.translateAudio({ input: {} } as any)).rejects.toThrow("Audio translation requires an input file");
        await expect(
            cap.translateAudio({ input: { file: { type: "audio/wav" }, targetLanguage: "de" } } as any)
        ).rejects.toThrow("OpenAI audio translation currently supports English as the target language");
    });

    it("transcribeAudio maps transcript and usage metadata", async () => {
        const provider = makeProvider();
        const create = vi.fn().mockResolvedValue({
            text: "hello world",
            usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5, type: "tokens" },
            language: "en",
            duration: 12.5,
            segments: [{ id: "s1", start: 0, end: 1.2, text: "hello", speaker: "A" }],
            words: [{ word: "hello", start: 0, end: 0.4, confidence: 0.9, speaker: "A" }]
        });
        const client = {
            audio: {
                transcriptions: {
                    create
                }
            }
        };

        const cap = new OpenAIAudioCapabilityImpl(provider, client as any);
        const res = await cap.transcribeAudio({
            input: {
                file: { type: "audio/wav" },
                responseFormat: "verbose_json",
                prompt: "domain terms",
                temperature: 0.2,
                include: ["logprobs"],
                stream: false,
                knownSpeakerNames: ["A", "B"]
            },
            context: { requestId: "r1", metadata: { trace: "x" } }
        } as any);

        expect(res.output[0]?.transcript).toBe("hello world");
        expect(res.output[0]?.kind).toBe("transcription");
        expect(res.output[0]?.mimeType).toBe("audio/wav");
        expect(res.output[0]?.language).toBe("en");
        expect(res.output[0]?.durationSeconds).toBe(12.5);
        expect(res.output[0]?.id).toBe("r1");
        expect(res.output[0]?.segments?.[0]?.text).toBe("hello");
        expect(res.output[0]?.words?.[0]?.word).toBe("hello");
        expect(res.multimodalArtifacts?.audio).toHaveLength(1);
        expect(res.id).toBe("r1");
        expect(res.metadata?.provider).toBe("openai");
        expect(res.metadata?.requestId).toBe("r1");
        expect(res.metadata?.totalTokens).toBe(5);
        expect(create).toHaveBeenCalledWith(
            expect.objectContaining({
                response_format: "verbose_json",
                prompt: "domain terms",
                temperature: 0.2,
                include: ["logprobs"],
                stream: false,
                known_speaker_names: ["A", "B"]
            }),
            expect.any(Object)
        );
    });

    it("translateAudio maps translated text", async () => {
        const provider = makeProvider();
        const client = {
            audio: {
                translations: {
                    create: vi.fn().mockResolvedValue({ id: "tr_1", text: "translated text" })
                }
            }
        };

        const cap = new OpenAIAudioCapabilityImpl(provider, client as any);
        const res = await cap.translateAudio({
            input: { file: { type: "audio/mpeg" }, targetLanguage: "en", responseFormat: "text" }
        } as any);

        expect(res.output[0]?.transcript).toBe("translated text");
        expect(res.output[0]?.id).toBe("tr_1");
        expect(res.output[0]?.kind).toBe("translation");
        expect(res.output[0]?.language).toBe("en");
        expect(res.id).toBe("tr_1");
        expect(res.metadata?.provider).toBe("openai");
    });

    it("transcribeAudio infers duration from segment timings when provider duration is missing", async () => {
        const provider = makeProvider();
        const client = {
            audio: {
                transcriptions: {
                    create: vi.fn().mockResolvedValue({
                        text: "hello world",
                        segments: [{ id: "s1", start: 0, end: 2.75, text: "hello world" }]
                    })
                }
            }
        };
        const cap = new OpenAIAudioCapabilityImpl(provider, client as any);
        const res = await cap.transcribeAudio({
            input: { file: { type: "audio/wav" } },
            context: { requestId: "r_infer_duration" }
        } as any);

        expect(res.output[0]?.durationSeconds).toBe(2.75);
        expect(res.output[0]?.id).toBe("r_infer_duration");
    });

    it("textToSpeech maps response bytes into base64 audio artifact", async () => {
        const provider = makeProvider();
        const client = {
            audio: {
                speech: {
                    create: vi.fn().mockResolvedValue({
                        id: "tts_1",
                        url: "https://cdn.example.com/audio.mp3",
                        arrayBuffer: vi.fn().mockResolvedValue(Uint8Array.from([1, 2, 3]).buffer),
                        headers: { get: vi.fn().mockReturnValue("audio/mpeg") }
                    })
                }
            }
        };

        const cap = new OpenAIAudioCapabilityImpl(provider, client as any);
        const res = await cap.textToSpeech({
            input: { text: "hello", voice: "alloy", format: "mp3", speed: 1.1, instructions: "calm", streamFormat: "audio" }
        } as any);

        expect(res.output).toHaveLength(1);
        expect(res.output[0]?.kind).toBe("tts");
        expect(res.output[0]?.id).toBe("tts_1");
        expect(res.output[0]?.base64).toBe("AQID");
        expect(res.output[0]?.url).toBe("https://cdn.example.com/audio.mp3");
        expect(res.id).toBe("tts_1");
        expect(res.multimodalArtifacts?.audio).toHaveLength(1);
        expect(client.audio.speech.create).toHaveBeenCalledWith(
            expect.objectContaining({
                instructions: "calm",
                speed: 1.1,
                stream_format: "audio"
            }),
            expect.any(Object)
        );
    });

    it("textToSpeech ignores OpenAI API endpoint url as artifact url", async () => {
        const provider = makeProvider();
        const client = {
            audio: {
                speech: {
                    create: vi.fn().mockResolvedValue({
                        url: "https://api.openai.com/v1/audio/speech",
                        arrayBuffer: vi.fn().mockResolvedValue(Uint8Array.from([1, 2, 3]).buffer),
                        headers: { get: vi.fn().mockReturnValue("audio/mpeg") }
                    })
                }
            }
        };

        const cap = new OpenAIAudioCapabilityImpl(provider, client as any);
        const res = await cap.textToSpeech({ input: { text: "hello", format: "mp3" } } as any);

        expect(res.output[0]?.base64).toBe("AQID");
        expect(res.output[0]?.url).toBeUndefined();
    });

    it("textToSpeech enforces maxTtsOutputBytes", async () => {
        const provider = makeProvider();
        const client = {
            audio: {
                speech: {
                    create: vi.fn().mockResolvedValue({
                        arrayBuffer: vi.fn().mockResolvedValue(Uint8Array.from([1, 2, 3, 4]).buffer),
                        headers: { get: vi.fn().mockReturnValue("audio/mpeg") }
                    })
                }
            }
        };

        const cap = new OpenAIAudioCapabilityImpl(provider, client as any);
        await expect(
            cap.textToSpeech({
                input: { text: "hello", format: "mp3" },
                options: { generalParams: { maxTtsOutputBytes: 2 } }
            } as any)
        ).rejects.toThrow("[AUDIO_OUTPUT_TOO_LARGE]");
    });

    it("resolves mime type from explicit mimeType and filename hints", async () => {
        const provider = makeProvider();
        const client = {
            audio: {
                transcriptions: { create: vi.fn().mockResolvedValue({ text: "x" }) },
                translations: { create: vi.fn().mockResolvedValue({ text: "y" }) }
            }
        };
        const cap = new OpenAIAudioCapabilityImpl(provider, client as any);

        const a = await cap.transcribeAudio({ input: { file: "s3://a", mimeType: "audio/flac" } } as any);
        const b = await cap.translateAudio({ input: { file: "clip.ogg", filename: "clip.ogg", targetLanguage: "en" } } as any);

        expect(a.output[0]?.mimeType).toBe("audio/flac");
        expect(b.output[0]?.mimeType).toBe("audio/ogg");
    });

    it("transcribeAudioStream emits incremental and final chunks", async () => {
        const provider = makeProvider();
        provider.getMergedOptions = vi.fn((_capability: string, runtimeOptions: any) => ({
            model: runtimeOptions?.model,
            modelParams: {},
            providerParams: {},
            generalParams: { audioStreamBatchSize: 2 }
        }));

        const events = async function* () {
            yield { type: "transcript.text.delta", delta: "he", id: "resp_1" };
            yield { type: "transcript.text.delta", delta: "llo" };
        };

        const client = {
            audio: {
                transcriptions: {
                    create: vi.fn().mockResolvedValue(events())
                }
            }
        };

        const cap = new OpenAIAudioCapabilityImpl(provider, client as any);
        const chunks = await collect(
            cap.transcribeAudioStream({
                input: { file: { type: "audio/wav" } },
                context: { requestId: "req_1" }
            } as any)
        );

        expect(chunks.length).toBeGreaterThanOrEqual(2);
        expect(chunks[0]?.output).toBeUndefined();
        expect(chunks.at(-1)?.done).toBe(true);
        expect(chunks.at(-1)?.output?.[0]?.transcript).toBe("hello");
        expect(chunks.at(-1)?.multimodalArtifacts?.audio?.[0]?.kind).toBe("transcription");
    });

    it("transcribeAudioStream supports non-iterable fallback responses", async () => {
        const provider = makeProvider();
        const client = {
            audio: {
                transcriptions: {
                    create: vi.fn().mockResolvedValue({ text: "fallback transcript" })
                }
            }
        };

        const cap = new OpenAIAudioCapabilityImpl(provider, client as any);
        const chunks = await collect(
            cap.transcribeAudioStream({
                input: { file: { type: "audio/wav" } },
                context: { requestId: "req_fallback" }
            } as any)
        );

        expect(chunks).toHaveLength(1);
        expect(chunks[0]?.done).toBe(true);
        expect(chunks[0]?.output?.[0]?.transcript).toBe("fallback transcript");
        expect(chunks[0]?.metadata?.audioFallbackUsed).toBe(true);
    });

    it("transcribeAudioStream parses text/transcript/segment delta variants", async () => {
        const provider = makeProvider();
        provider.getMergedOptions = vi.fn((_capability: string, runtimeOptions: any) => ({
            model: runtimeOptions?.model,
            modelParams: {},
            providerParams: {},
            generalParams: { audioStreamBatchSize: 1 }
        }));

        const events = async function* () {
            yield { type: "transcript.text.delta", text: "a", response: { id: "resp_nested" } };
            yield { type: "transcript.text.delta", transcript: "b" };
            yield { segment: { text: "c" } };
        };

        const client = {
            audio: {
                transcriptions: {
                    create: vi.fn().mockResolvedValue(events())
                }
            }
        };

        const cap = new OpenAIAudioCapabilityImpl(provider, client as any);
        const chunks = await collect(cap.transcribeAudioStream({ input: { file: { type: "audio/wav" } } } as any));

        expect(chunks.at(-1)?.done).toBe(true);
        expect(chunks.at(-1)?.id).toBe("resp_nested");
        expect(chunks.at(-1)?.output?.[0]?.transcript).toBe("abc");
    });

    it("transcribeAudioStream parses audio error code from generic error message", async () => {
        const provider = makeProvider();
        const client = {
            audio: {
                transcriptions: {
                    create: vi.fn().mockRejectedValue(new Error("[AUDIO_INVALID_PAYLOAD] transcription stream failed"))
                }
            }
        };

        const cap = new OpenAIAudioCapabilityImpl(provider, client as any);
        const chunks = await collect(cap.transcribeAudioStream({ input: { file: { type: "audio/wav" } } } as any));

        expect(chunks.at(-1)?.done).toBe(true);
        expect(chunks.at(-1)?.metadata?.audioErrorCode).toBe("AUDIO_INVALID_PAYLOAD");
    });

    it("textToSpeechStream emits byte deltas and final aggregated output", async () => {
        const provider = makeProvider();
        const reader = {
            read: vi
                .fn()
                .mockResolvedValueOnce({ done: false, value: Uint8Array.from([1, 2]) })
                .mockResolvedValueOnce({ done: false, value: Uint8Array.from([3]) })
                .mockResolvedValueOnce({ done: true, value: undefined }),
            cancel: vi.fn().mockResolvedValue(undefined)
        };

        const client = {
            audio: {
                speech: {
                    create: vi.fn().mockResolvedValue({
                        id: "resp_tts_1",
                        headers: { get: vi.fn().mockReturnValue("audio/mpeg") },
                        body: { getReader: () => reader }
                    })
                }
            }
        };

        const cap = new OpenAIAudioCapabilityImpl(provider, client as any);
        const chunks = await collect(
            cap.textToSpeechStream({
                input: { text: "hello", format: "mp3" },
                context: { requestId: "req_2" }
            } as any)
        );

        expect(chunks.length).toBe(3);
        expect(chunks[0]?.done).toBe(false);
        expect(chunks[0]?.delta?.[0]?.base64).toBe("AQI=");
        expect(chunks[1]?.delta?.[0]?.base64).toBe("Aw==");
        expect(chunks[2]?.done).toBe(true);
        expect(chunks[2]?.output?.[0]?.base64).toBe("AQID");
        expect(chunks[2]?.multimodalArtifacts?.audio).toHaveLength(1);
    });

    it("textToSpeechStream fails when cumulative streamed bytes exceed maxTtsOutputBytes", async () => {
        const provider = makeProvider();
        const reader = {
            read: vi
                .fn()
                .mockResolvedValueOnce({ done: false, value: Uint8Array.from([1, 2]) })
                .mockResolvedValueOnce({ done: false, value: Uint8Array.from([3, 4]) })
                .mockResolvedValueOnce({ done: true, value: undefined }),
            cancel: vi.fn().mockResolvedValue(undefined)
        };

        const client = {
            audio: {
                speech: {
                    create: vi.fn().mockResolvedValue({
                        id: "resp_tts_limit",
                        headers: { get: vi.fn().mockReturnValue("audio/mpeg") },
                        body: { getReader: () => reader }
                    })
                }
            }
        };

        const cap = new OpenAIAudioCapabilityImpl(provider, client as any);
        const chunks = await collect(
            cap.textToSpeechStream({
                input: { text: "hello", format: "mp3" },
                options: { generalParams: { maxTtsOutputBytes: 3 } }
            } as any)
        );

        expect(chunks.at(-1)?.done).toBe(true);
        expect(chunks.at(-1)?.error).toContain("[AUDIO_OUTPUT_TOO_LARGE]");
        expect(chunks.at(-1)?.metadata?.audioErrorCode).toBe("AUDIO_OUTPUT_TOO_LARGE");
    });

    it("textToSpeechStream skips empty chunk values and still completes", async () => {
        const provider = makeProvider();
        const reader = {
            read: vi
                .fn()
                .mockResolvedValueOnce({ done: false, value: new Uint8Array(0) })
                .mockResolvedValueOnce({ done: false, value: new Uint8Array(0) })
                .mockResolvedValueOnce({ done: false, value: Uint8Array.from([7, 8]) })
                .mockResolvedValueOnce({ done: true, value: undefined }),
            cancel: vi.fn().mockResolvedValue(undefined)
        };
        const client = {
            audio: {
                speech: {
                    create: vi.fn().mockResolvedValue({
                        id: "resp_tts_empty_chunk",
                        headers: { get: vi.fn().mockReturnValue("audio/mpeg") },
                        body: { getReader: () => reader }
                    })
                }
            }
        };
        const cap = new OpenAIAudioCapabilityImpl(provider, client as any);
        const chunks = await collect(cap.textToSpeechStream({ input: { text: "hello", format: "mp3" } } as any));

        expect(chunks.at(-1)?.done).toBe(true);
        expect(chunks.at(-1)?.output?.[0]?.base64).toBe("Bwg=");
    });

    it("textToSpeechStream parses audio error code from generic error message", async () => {
        const provider = makeProvider();
        const client = {
            audio: {
                speech: {
                    create: vi.fn().mockRejectedValue(new Error("[AUDIO_INVALID_PAYLOAD] malformed stream payload"))
                }
            }
        };

        const cap = new OpenAIAudioCapabilityImpl(provider, client as any);
        const chunks = await collect(cap.textToSpeechStream({ input: { text: "hello", format: "mp3" } } as any));

        expect(chunks.at(-1)?.done).toBe(true);
        expect(chunks.at(-1)?.error).toContain("[AUDIO_INVALID_PAYLOAD]");
        expect(chunks.at(-1)?.metadata?.audioErrorCode).toBe("AUDIO_INVALID_PAYLOAD");
    });

    it("textToSpeechStream returns AUDIO_EMPTY_RESPONSE when stream ends without any chunks", async () => {
        const provider = makeProvider();
        const reader = {
            read: vi.fn().mockResolvedValueOnce({ done: true, value: undefined }),
            cancel: vi.fn().mockResolvedValue(undefined)
        };
        const client = {
            audio: {
                speech: {
                    create: vi.fn().mockResolvedValue({
                        id: "resp_tts_none",
                        headers: { get: vi.fn().mockReturnValue("audio/mpeg") },
                        body: { getReader: () => reader }
                    })
                }
            }
        };
        const cap = new OpenAIAudioCapabilityImpl(provider, client as any);
        const chunks = await collect(cap.textToSpeechStream({ input: { text: "hello", format: "mp3" } } as any));

        expect(chunks.at(-1)?.done).toBe(true);
        expect(chunks.at(-1)?.error).toContain("[AUDIO_EMPTY_RESPONSE]");
        expect(chunks.at(-1)?.metadata?.audioErrorCode).toBe("AUDIO_EMPTY_RESPONSE");
    });

    it("textToSpeechStream cancels reader and exits when aborted during read loop", async () => {
        const provider = makeProvider();
        const reader = {
            read: vi.fn().mockResolvedValue({ done: false, value: Uint8Array.from([1]) }),
            cancel: vi.fn().mockResolvedValue(undefined)
        };
        const client = {
            audio: {
                speech: {
                    create: vi.fn().mockResolvedValue({
                        id: "resp_tts_abort",
                        headers: { get: vi.fn().mockReturnValue("audio/mpeg") },
                        body: { getReader: () => reader }
                    })
                }
            }
        };

        const cap = new OpenAIAudioCapabilityImpl(provider, client as any);
        const abortController = new AbortController();
        abortController.abort("stop");
        const chunks = await collect(
            cap.textToSpeechStream(
                { input: { text: "hello", format: "mp3" } } as any,
                undefined,
                abortController.signal
            )
        );

        expect(chunks).toHaveLength(0);
        expect(reader.cancel).toHaveBeenCalledTimes(1);
    });

    it("internal URL helpers handle candidate forms and malformed urls", () => {
        const cap = new OpenAIAudioCapabilityImpl(makeProvider(), {} as any);
        const internal = cap as any;

        expect(internal.extractNonDataUrl(null)).toBeUndefined();
        expect(
            internal.extractNonDataUrl({
                data: [{ url: "https://cdn.example.com/from-data.mp3" }]
            })
        ).toBe("https://cdn.example.com/from-data.mp3");
        expect(
            internal.extractNonDataUrl({
                output: [{ url: "https://cdn.example.com/from-output.mp3" }]
            })
        ).toBe("https://cdn.example.com/from-output.mp3");

        expect(internal.isLikelyAssetUrl("https://api.openai.com/v1/audio/speech")).toBe(false);
        expect(internal.isLikelyAssetUrl("https://")).toBe(false);
    });

    it("internal stream/transcript helper paths normalize expected variants", () => {
        const cap = new OpenAIAudioCapabilityImpl(makeProvider(), {} as any);
        const internal = cap as any;

        expect(internal.extractEventResponseId({ id: "a" })).toBe("a");
        expect(internal.extractEventResponseId({ response: { id: "b" } })).toBe("b");
        expect(internal.extractEventResponseId({})).toBeUndefined();

        const asyncIterable = {
            async *[Symbol.asyncIterator]() {
                yield 1;
            }
        };
        expect(internal.isAsyncIterable(asyncIterable)).toBe(true);
        expect(internal.isAsyncIterable({})).toBe(false);

        expect(internal.extractTranscriptionDelta({ delta: "d" })).toBe("d");
        expect(internal.extractTranscriptionDelta({ type: "transcript.text.delta", text: "t" })).toBe("t");
        expect(internal.extractTranscriptionDelta({ type: "transcript.text.delta", transcript: "r" })).toBe("r");
        expect(internal.extractTranscriptionDelta({ segment: { text: "s" } })).toBe("s");
        expect(internal.extractTranscriptionDelta(null)).toBe("");
        expect(internal.extractTranscriptionDelta({ type: "other", text: "ignored" })).toBe("");
    });

    it("internal segment/word mappers filter invalid records", () => {
        const cap = new OpenAIAudioCapabilityImpl(makeProvider(), {} as any);
        const internal = cap as any;

        expect(internal.extractSegments({ segments: [] })).toBeUndefined();
        expect(internal.extractSegments({ segments: [{ text: "ok", start: 0, end: 1 }, { invalid: true }] })).toEqual([
            { id: undefined, startSeconds: 0, endSeconds: 1, text: "ok", speaker: undefined }
        ]);

        expect(internal.extractWords({ words: [] })).toBeUndefined();
        expect(internal.extractWords({ words: [{ word: "hello", start: 0, end: 1, confidence: 0.5 }, { x: 1 }] })).toEqual([
            { word: "hello", startSeconds: 0, endSeconds: 1, confidence: 0.5, speaker: undefined }
        ]);
    });
});
