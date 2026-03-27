import { afterEach, describe, expect, it, vi } from "vitest";
import { MistralChatCapabilityImpl } from "#root/providers/mistral/capabilities/MistralChatCapabilityImpl.js";
import { MistralEmbedCapabilityImpl } from "#root/providers/mistral/capabilities/MistralEmbedCapabilityImpl.js";
import { MistralModerationCapabilityImpl } from "#root/providers/mistral/capabilities/MistralModerationCapabilityImpl.js";
import { MistralImageAnalysisCapabilityImpl } from "#root/providers/mistral/capabilities/MistralImageAnalysisCapabilityImpl.js";
import { MistralAudioTranscriptionCapabilityImpl } from "#root/providers/mistral/capabilities/MistralAudioTranscriptionCapabilityImpl.js";
import { MistralAudioTextToSpeechCapabilityImpl } from "#root/providers/mistral/capabilities/MistralAudioTextToSpeechCapabilityImpl.js";
import { CapabilityKeys } from "#root/index.js";

function makeProvider(overrides?: Record<string, unknown>) {
    return {
        ensureInitialized: vi.fn(),
        getMergedOptions: vi.fn((capability: string) => {
            if (capability === CapabilityKeys.ChatCapabilityKey || capability === CapabilityKeys.ChatStreamCapabilityKey) {
                return { model: "mistral-small-latest", modelParams: {}, providerParams: {}, generalParams: {} };
            }
            if (capability === CapabilityKeys.EmbedCapabilityKey) {
                return { model: "mistral-embed", modelParams: {}, providerParams: {}, generalParams: {} };
            }
            if (capability === CapabilityKeys.ModerationCapabilityKey) {
                return { model: "mistral-moderation-latest", modelParams: {}, providerParams: {}, generalParams: {} };
            }
            if (
                capability === CapabilityKeys.AudioTranscriptionCapabilityKey ||
                capability === CapabilityKeys.AudioTranscriptionStreamCapabilityKey
            ) {
                return { model: "voxtral-mini-latest", modelParams: {}, providerParams: {}, generalParams: { audioStreamBatchSize: 8 } };
            }
            if (
                capability === CapabilityKeys.AudioTextToSpeechCapabilityKey ||
                capability === CapabilityKeys.AudioTextToSpeechStreamCapabilityKey
            ) {
                return { model: "voxtral-mini-tts-2603", modelParams: {}, providerParams: {}, generalParams: { audioStreamBatchSize: 8 } };
            }
            return { model: "mistral-small-latest", modelParams: {}, providerParams: {}, generalParams: {} };
        }),
        ...(overrides ?? {})
    } as any;
}

afterEach(() => {
    vi.restoreAllMocks();
});

describe("Mistral capability implementations", () => {
    it("chat normalizes non-streaming and streaming responses", async () => {
        const client = {
            chat: {
                complete: vi.fn().mockResolvedValue({
                    id: "chat-1",
                    model: "mistral-small-latest",
                    usage: { promptTokens: 4, completionTokens: 3, totalTokens: 7 },
                    choices: [{ message: { role: "assistant", content: "hello from mistral" } }]
                }),
                stream: vi.fn().mockResolvedValue(
                    (async function* () {
                        yield { data: { id: "stream-1", model: "mistral-small-latest", choices: [{ delta: { content: "hello " } }] } };
                        yield {
                            data: {
                                id: "stream-1",
                                model: "mistral-small-latest",
                                usage: { promptTokens: 4, completionTokens: 2, totalTokens: 6 },
                                choices: [{ delta: { content: "world" } }]
                            }
                        };
                    })()
                )
            }
        } as any;

        const cap = new MistralChatCapabilityImpl(makeProvider(), client);

        const response = await cap.chat({
            input: { messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] },
            context: { requestId: "r1" }
        } as any);
        expect(response.output.content).toEqual([{ type: "text", text: "hello from mistral" }]);
        expect(response.metadata?.provider).toBe("mistral");
        expect(response.metadata?.totalTokens).toBe(7);

        const streamChunks: any[] = [];
        for await (const chunk of cap.chatStream({
            input: { messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] },
            context: { requestId: "r2" }
        } as any)) {
            streamChunks.push(chunk);
        }

        expect(streamChunks).toHaveLength(2);
        expect(streamChunks[0].delta?.content).toEqual([{ type: "text", text: "hello world" }]);
        expect(streamChunks[1].output?.content).toEqual([{ type: "text", text: "hello world" }]);
        expect(streamChunks[1].done).toBe(true);
    });

    it("embed normalizes embeddings response", async () => {
        const client = {
            embeddings: {
                create: vi.fn().mockResolvedValue({
                    id: "emb-1",
                    model: "mistral-embed",
                    usage: { totalTokens: 5 },
                    data: [
                        { index: 1, embedding: [0.2, 0.3] },
                        { index: 0, embedding: [0.1] }
                    ]
                })
            }
        } as any;

        const cap = new MistralEmbedCapabilityImpl(makeProvider(), client);

        const response = await cap.embed({ input: { input: ["a", "b"] }, context: { requestId: "r3" } } as any);
        expect(response.output).toHaveLength(2);
        expect(response.output[0].vector).toEqual([0.1]);
        expect(response.metadata?.tokensUsed).toBe(5);
    });

    it("moderation normalizes category results", async () => {
        const client = {
            classifiers: {
                moderate: vi.fn().mockResolvedValue({
                    id: "mod-1",
                    model: "mistral-moderation-latest",
                    results: [
                        {
                            categories: { violence: true, sexual: false },
                            categoryScores: { violence: 0.99, sexual: 0.02 }
                        }
                    ]
                })
            }
        } as any;

        const cap = new MistralModerationCapabilityImpl(makeProvider(), client);
        const response = await cap.moderation({ input: { input: "unsafe" }, context: { requestId: "r4" } } as any);

        expect(response.output[0].flagged).toBe(true);
        expect(response.output[0].categories.violence).toBe(true);
        expect(response.output[0].reason).toContain("violence");
    });

    it("image analysis normalizes JSON chat output", async () => {
        const client = {
            chat: {
                complete: vi.fn().mockResolvedValue({
                    id: "img-1",
                    model: "mistral-small-latest",
                    choices: [
                        {
                            message: {
                                content: JSON.stringify([
                                    {
                                        imageIndex: 0,
                                        description: "a cat on a chair",
                                        tags: ["cat", "chair"],
                                        objects: [{ label: "cat" }],
                                        text: [{ text: "hello" }],
                                        safety: { flagged: false, categories: { violence: false } }
                                    }
                                ])
                            }
                        }
                    ]
                })
            }
        } as any;

        const cap = new MistralImageAnalysisCapabilityImpl(makeProvider(), client);
        const response = await cap.analyzeImage({
            input: {
                images: [{ id: "img-1", sourceType: "url", url: "https://example.com/cat.png" }]
            },
            context: { requestId: "r5" }
        } as any);

        expect(response.output).toHaveLength(1);
        expect(response.output[0].description).toBe("a cat on a chair");
        expect(response.output[0].sourceImageId).toBe("img-1");
        expect(response.output[0].objects?.[0]?.label).toBe("cat");
    });

    it("audio transcription normalizes non-streaming and streaming responses", async () => {
        const client = {
            audio: {
                transcriptions: {
                    complete: vi.fn().mockResolvedValue({
                        model: "voxtral-mini-latest",
                        text: "hello from mistral audio",
                        usage: { promptTokens: 4, totalTokens: 4 },
                        language: "en"
                    }),
                    stream: vi.fn().mockResolvedValue(
                        (async function* () {
                            yield {
                                event: "transcription.text.delta",
                                data: { type: "transcription.text.delta", text: "hello " }
                            };
                            yield {
                                event: "transcription.done",
                                data: {
                                    type: "transcription.done",
                                    model: "voxtral-mini-latest",
                                    text: "hello world",
                                    usage: { promptTokens: 5, totalTokens: 5 },
                                    language: "en"
                                }
                            };
                        })()
                    )
                }
            }
        } as any;

        const cap = new MistralAudioTranscriptionCapabilityImpl(makeProvider(), client);

        const response = await cap.transcribeAudio({ input: { file: Buffer.from("abc") }, context: { requestId: "r6" } } as any, {} as any);
        expect(response.output[0]?.content).toEqual([{ type: "text", text: "hello from mistral audio" }]);
        expect(response.metadata?.provider).toBe("mistral");

        const chunks: any[] = [];
        for await (const chunk of cap.transcribeAudioStream(
            { input: { file: Buffer.from("abc") }, context: { requestId: "r7" } } as any,
            {} as any
        )) {
            chunks.push(chunk);
        }

        expect(chunks).toHaveLength(2);
        expect(chunks[0].delta?.[0]?.content).toEqual([{ type: "text", text: "hello " }]);
        expect(chunks[1].output?.[0]?.content).toEqual([{ type: "text", text: "hello world" }]);
        expect(chunks[1].done).toBe(true);
    });

    it("tts normalizes non-streaming and streaming responses", async () => {
        const client = {
            audio: {
                speech: {
                    complete: vi
                        .fn()
                        .mockResolvedValueOnce({ audioData: Buffer.from("tts-audio").toString("base64") })
                        .mockResolvedValueOnce(
                            (async function* () {
                                yield {
                                    event: "speech.audio.delta",
                                    data: {
                                        type: "speech.audio.delta",
                                        audioData: Buffer.from("ab").toString("base64")
                                    }
                                };
                                yield {
                                    event: "speech.audio.done",
                                    data: {
                                        type: "speech.audio.done",
                                        usage: { totalTokens: 3 }
                                    }
                                };
                            })()
                        )
                }
            }
        } as any;

        const cap = new MistralAudioTextToSpeechCapabilityImpl(makeProvider(), client);

        const response = await cap.textToSpeech(
            { input: { text: "hello", voice: "voice-1", format: "mp3" }, context: { requestId: "r8" } } as any,
            {} as any
        );
        expect(response.output[0]?.mimeType).toBe("audio/mpeg");
        expect(response.output[0]?.base64).toBe(Buffer.from("tts-audio").toString("base64"));

        const chunks: any[] = [];
        for await (const chunk of cap.textToSpeechStream(
            { input: { text: "hello", voice: "voice-1", format: "wav" }, context: { requestId: "r9" } } as any,
            {} as any
        )) {
            chunks.push(chunk);
        }

        expect(chunks).toHaveLength(2);
        expect(chunks[0].delta?.[0]?.base64).toBe(Buffer.from("ab").toString("base64"));
        expect(chunks[1].done).toBe(true);
        expect(chunks[1].output?.[0]?.mimeType).toBe("audio/wav");
    });

    it("tts accepts modelParams.voiceId as the project-level default voice", async () => {
        const provider = makeProvider({
            getMergedOptions: vi.fn((capability: string) => {
                if (capability === CapabilityKeys.AudioTextToSpeechCapabilityKey) {
                    return {
                        model: "voxtral-mini-tts-2603",
                        modelParams: { voiceId: "config-voice-id" },
                        providerParams: {},
                        generalParams: {}
                    };
                }
                return { model: "mistral-small-latest", modelParams: {}, providerParams: {}, generalParams: {} };
            })
        });

        const complete = vi.fn().mockResolvedValue({ audioData: Buffer.from("cfg-voice").toString("base64") });
        const cap = new MistralAudioTextToSpeechCapabilityImpl(provider, {
            audio: {
                speech: { complete }
            }
        } as any);

        const response = await cap.textToSpeech({ input: { text: "hello from config voice", format: "mp3" } } as any, {} as any);

        expect(response.output[0]?.mimeType).toBe("audio/mpeg");
        expect(complete).toHaveBeenCalledWith(
            expect.objectContaining({ voiceId: "config-voice-id", input: "hello from config voice" }),
            expect.any(Object)
        );
    });
});
