import fs from "node:fs";
import * as fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MistralChatCapabilityImpl } from "#root/providers/mistral/capabilities/MistralChatCapabilityImpl.js";
import { MistralEmbedCapabilityImpl } from "#root/providers/mistral/capabilities/MistralEmbedCapabilityImpl.js";
import { MistralModerationCapabilityImpl } from "#root/providers/mistral/capabilities/MistralModerationCapabilityImpl.js";
import { MistralImageAnalysisCapabilityImpl } from "#root/providers/mistral/capabilities/MistralImageAnalysisCapabilityImpl.js";
import { MISTRAL_OCR_FORMATS, MistralOCRCapabilityImpl } from "#root/providers/mistral/capabilities/MistralOCRCapabilityImpl.js";
import { MistralAudioTranscriptionCapabilityImpl } from "#root/providers/mistral/capabilities/MistralAudioTranscriptionCapabilityImpl.js";
import { MistralAudioTextToSpeechCapabilityImpl } from "#root/providers/mistral/capabilities/MistralAudioTextToSpeechCapabilityImpl.js";
import { tryParseAnnotationJson } from "#root/providers/mistral/capabilities/shared/MistralOCROutputUtils.js";
import { CapabilityKeys, extractReadableTextFromOCRMarkdown, normalizeOCRMarkdownTableOutput } from "#root/index.js";

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
            if (capability === CapabilityKeys.OCRCapabilityKey) {
                return { model: "mistral-ocr-latest", modelParams: {}, providerParams: {}, generalParams: {} };
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

const makeTempFile = (name: string, content: string) => {
    const filePath = path.join(os.tmpdir(), `providerplaneai-${Date.now()}-${Math.random().toString(36).slice(2)}-${name}`);
    fs.writeFileSync(filePath, content, "utf8");
    return filePath;
};

async function collect<T>(iter: AsyncGenerator<T>): Promise<T[]> {
    const out: T[] = [];
    for await (const item of iter) {
        out.push(item);
    }
    return out;
}

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

    it("chat forwards multimodal content and provider params to Mistral", async () => {
        const provider = makeProvider({
            getMergedOptions: vi.fn((capability: string) => {
                if (capability === CapabilityKeys.ChatCapabilityKey) {
                    return {
                        model: "mistral-small-latest",
                        modelParams: { temperature: 0.2 },
                        providerParams: { timeoutMs: 3210 },
                        generalParams: {}
                    };
                }
                return { model: "mistral-small-latest", modelParams: {}, providerParams: {}, generalParams: {} };
            })
        });
        const complete = vi.fn().mockResolvedValue({
            id: "chat-mm-1",
            model: "mistral-small-latest",
            choices: [
                {
                    message: {
                        content: [
                            { type: "text", text: "hello " },
                            { type: "text", text: "image" }
                        ]
                    }
                }
            ]
        });
        const cap = new MistralChatCapabilityImpl(provider, { chat: { complete } } as any);

        const response = await cap.chat({
            input: {
                messages: [
                    { role: "system", content: [{ type: "text", text: "Be precise." }] },
                    {
                        role: "user",
                        content: [
                            { type: "text", text: "Describe this" },
                            { type: "image", base64: Buffer.from("image").toString("base64"), mimeType: "image/png" }
                        ]
                    }
                ]
            }
        } as any);

        expect(response.output.content).toEqual([{ type: "text", text: "hello image" }]);
        expect(complete).toHaveBeenCalledWith(
            expect.objectContaining({
                model: "mistral-small-latest",
                temperature: 0.2,
                messages: [
                    { role: "system", content: "Be precise." },
                    {
                        role: "user",
                        content: [
                            { type: "text", text: "Describe this" },
                            {
                                type: "image_url",
                                imageUrl: expect.stringMatching(/^data:image\/png;base64,/)
                            }
                        ]
                    }
                ]
            }),
            expect.objectContaining({ timeoutMs: 3210 })
        );
    });

    it("chat handles assistant-role content arrays, aborted streams, and empty deltas", async () => {
        const streamAbort = new AbortController();
        const client = {
            chat: {
                complete: vi.fn().mockResolvedValue({
                    id: "chat-assistant-1",
                    model: "mistral-small-latest",
                    choices: [
                        {
                            message: {
                                content: [
                                    { type: "text", text: "assistant " },
                                    { type: "text", text: "reply" }
                                ]
                            }
                        }
                    ]
                }),
                stream: vi.fn().mockResolvedValue(
                    (async function* () {
                        yield { data: { id: "stream-empty-1", choices: [{ delta: { content: null } }] } };
                        streamAbort.abort();
                        yield { data: { id: "stream-empty-1", choices: [{ delta: { content: "ignored" } }] } };
                    })()
                )
            }
        } as any;

        const cap = new MistralChatCapabilityImpl(makeProvider(), client);
        const response = await cap.chat({
            input: {
                messages: [{ role: "assistant", content: [{ type: "text", text: "prior assistant turn" }] }]
            }
        } as any);

        expect(response.output.content).toEqual([{ type: "text", text: "assistant reply" }]);

        const chunks: any[] = [];
        for await (const chunk of cap.chatStream(
            { input: { messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] } } as any,
            undefined,
            streamAbort.signal
        )) {
            chunks.push(chunk);
        }

        expect(chunks).toEqual([]);
    });

    it("chat rejects empty and already-aborted requests before calling Mistral", async () => {
        const complete = vi.fn();
        const cap = new MistralChatCapabilityImpl(makeProvider(), { chat: { complete } } as any);
        const controller = new AbortController();
        controller.abort();

        await expect(cap.chat({ input: { messages: [] } } as any)).rejects.toThrow("Received empty input messages");
        await expect(
            cap.chat(
                {
                    input: { messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] }
                } as any,
                undefined,
                controller.signal
            )
        ).rejects.toThrow("Request aborted");
        expect(complete).not.toHaveBeenCalled();
    });

    it("chat supports direct image URLs and stream completion with empty accumulated output", async () => {
        const client = {
            chat: {
                complete: vi.fn().mockResolvedValue({
                    id: undefined,
                    model: undefined,
                    choices: [{ message: { content: [{ type: "text", text: "url image ok" }] } }]
                }),
                stream: vi.fn().mockResolvedValue(
                    (async function* () {
                        yield { data: { id: undefined, choices: [{ delta: { content: null } }] } };
                    })()
                )
            }
        } as any;
        const cap = new MistralChatCapabilityImpl(makeProvider(), client);

        const response = await cap.chat({
            input: {
                messages: [
                    {
                        role: "user",
                        content: [
                            { type: "text", text: "describe" },
                            { type: "image", url: "https://example.com/image.png" }
                        ]
                    }
                ]
            }
        } as any);

        expect(response.output.content).toEqual([{ type: "text", text: "url image ok" }]);
        expect(client.chat.complete).toHaveBeenCalledWith(
            expect.objectContaining({
                messages: [
                    {
                        role: "user",
                        content: [
                            { type: "text", text: "describe" },
                            { type: "image_url", imageUrl: "https://example.com/image.png" }
                        ]
                    }
                ]
            }),
            expect.any(Object)
        );

        const chunks = await collect(
            cap.chatStream({
                input: { messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] }
            } as any)
        );

        expect(chunks).toHaveLength(1);
        expect(chunks[0]?.done).toBe(true);
        expect(chunks[0]?.delta?.content).toEqual([]);
        expect(chunks[0]?.output?.content).toEqual([]);
        expect(chunks[0]?.output?.id).toBeDefined();
    });

    it("chatStream validates input, flushes on batch threshold, and supports multi-part system content", async () => {
        const provider = makeProvider({
            getMergedOptions: vi.fn((capability: string) => {
                if (capability === CapabilityKeys.ChatStreamCapabilityKey) {
                    return {
                        model: "mistral-small-latest",
                        modelParams: {},
                        providerParams: {},
                        generalParams: { chatStreamBatchSize: 5 }
                    };
                }
                return { model: "mistral-small-latest", modelParams: {}, providerParams: {}, generalParams: {} };
            })
        });
        const stream = vi.fn().mockResolvedValue(
            (async function* () {
                yield { data: { id: "stream-batch-1", choices: [{ delta: { content: "hello" } }] } };
                yield { data: { id: "stream-batch-1", usage: { promptTokens: 1, completionTokens: 2, totalTokens: 3 }, choices: [{ delta: { content: " world" } }] } };
            })()
        );
        const cap = new MistralChatCapabilityImpl(provider, { chat: { stream } } as any);

        await expect(collect(cap.chatStream({ input: { messages: [] } } as any))).rejects.toThrow("Received empty input messages");

        const chunks = await collect(
            cap.chatStream({
                input: {
                    messages: [
                        {
                            role: "system",
                            content: [
                                { type: "text", text: "Be" },
                                { type: "text", text: " concise." }
                            ]
                        },
                        { role: "user", content: [{ type: "text", text: "hi" }] }
                    ]
                }
            } as any)
        );

        expect(chunks).toHaveLength(4);
        expect(chunks[0]?.delta?.content).toEqual([{ type: "text", text: "hello" }]);
        expect(chunks[1]?.delta?.content).toEqual([{ type: "text", text: " world" }]);
        expect(chunks[2]?.delta?.content).toEqual([]);
        expect(chunks[2]?.output?.content).toEqual([{ type: "text", text: "hello world" }]);
        expect(chunks[3]?.metadata?.totalTokens).toBe(3);
        expect(stream).toHaveBeenCalledWith(
            expect.objectContaining({
                messages: [
                    {
                        role: "system",
                        content: [
                            { type: "text", text: "Be" },
                            { type: "text", text: " concise." }
                        ]
                    },
                    { role: "user", content: "hi" }
                ]
            }),
            expect.any(Object)
        );
    });

    it("chatStream emits a terminal error chunk when the provider stream fails after startup", async () => {
        const cap = new MistralChatCapabilityImpl(makeProvider(), {
            chat: {
                stream: vi.fn().mockRejectedValue(new Error("stream exploded"))
            }
        } as any);

        const chunks = await collect(
            cap.chatStream({
                input: { messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] }
            } as any)
        );

        expect(chunks).toHaveLength(1);
        expect(chunks[0]?.done).toBe(true);
        expect(chunks[0]?.metadata?.provider).toBe("mistral");
        expect(chunks[0]?.metadata?.status).toBe("error");
        expect((chunks[0]?.metadata as any)?.error).toBeInstanceOf(Error);
        expect(((chunks[0]?.metadata as any)?.error as Error)?.message).toBe("stream exploded");
        expect(chunks[0]?.delta?.content).toEqual([]);
    });

    it("chat rejects unsupported user and system message parts", async () => {
        const cap = new MistralChatCapabilityImpl(
            makeProvider(),
            { chat: { complete: vi.fn(), stream: vi.fn() } } as any
        );

        await expect(
            cap.chat({
                input: {
                    messages: [
                        {
                            role: "system",
                            content: [{ type: "image", url: "https://example.com/system.png" }]
                        }
                    ]
                }
            } as any)
        ).rejects.toThrow("Mistral system messages do not support 'image' parts in v1");

        await expect(
            cap.chat({
                input: {
                    messages: [
                        {
                            role: "user",
                            content: [{ type: "audio", url: "https://example.com/audio.mp3" }]
                        }
                    ]
                }
            } as any)
        ).rejects.toThrow("Mistral chat does not support 'audio' message parts in v1");
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

    it("embed throws when Mistral returns no embeddings", async () => {
        const client = {
            embeddings: {
                create: vi.fn().mockResolvedValue({
                    id: "emb-empty-1",
                    model: "mistral-embed",
                    data: []
                })
            }
        } as any;

        const cap = new MistralEmbedCapabilityImpl(makeProvider(), client);

        await expect(cap.embed({ input: { input: "a" } } as any)).rejects.toThrow("Mistral returned no embeddings");
    });

    it("embed rejects invalid or aborted requests", async () => {
        const cap = new MistralEmbedCapabilityImpl(makeProvider(), { embeddings: { create: vi.fn() } } as any);
        const controller = new AbortController();
        controller.abort();

        await expect(cap.embed({ input: {} } as any)).rejects.toThrow("Invalid embedding input");
        await expect(cap.embed({ input: { input: "abc" } } as any, undefined, controller.signal)).rejects.toThrow("Request aborted");
    });

    it("embed uses promptTokens fallback and preserves scalar input metadata", async () => {
        const provider = makeProvider({
            getMergedOptions: vi.fn(() => ({
                model: undefined,
                modelParams: { encodingFormat: "float" },
                providerParams: { timeoutMs: 1234 },
                generalParams: {}
            }))
        });
        const create = vi.fn().mockResolvedValue({
            data: [{ index: 0, embedding: [0.4, 0.5, 0.6] }],
            usage: { promptTokens: 9 }
        });
        const cap = new MistralEmbedCapabilityImpl(provider, { embeddings: { create } } as any);

        const response = await cap.embed(
            {
                input: { input: "single text", inputId: "input-1", purpose: "search" },
                context: { requestId: "embed-scalar-1" }
            } as any
        );

        expect(response.output[0]?.inputId).toBe("input-1");
        expect(response.output[0]?.purpose).toBe("search");
        expect(response.output[0]?.metadata?.tokensUsed).toBe(9);
        expect(response.metadata?.model).toBe("mistral-embed");
        expect(create).toHaveBeenCalledWith(
            expect.objectContaining({
                model: "mistral-embed",
                encodingFormat: "float",
                inputs: "single text"
            }),
            expect.objectContaining({ timeoutMs: 1234 })
        );
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

    it("moderation throws when Mistral returns no moderation results", async () => {
        const client = {
            classifiers: {
                moderate: vi.fn().mockResolvedValue({
                    id: "mod-empty-1",
                    model: "mistral-moderation-latest",
                    results: []
                })
            }
        } as any;

        const cap = new MistralModerationCapabilityImpl(makeProvider(), client);
        await expect(cap.moderation({ input: { input: "safe" } } as any)).rejects.toThrow(
            "Mistral returned no moderation results"
        );
    });

    it("moderation rejects invalid or aborted requests", async () => {
        const cap = new MistralModerationCapabilityImpl(makeProvider(), { classifiers: { moderate: vi.fn() } } as any);
        const controller = new AbortController();
        controller.abort();

        await expect(cap.moderation({ input: {} } as any)).rejects.toThrow("Invalid moderation input");
        await expect(cap.moderation({ input: { input: "safe" } } as any, undefined, controller.signal)).rejects.toThrow(
            "Request aborted"
        );
    });

    it("moderation supports array inputs and unflagged results", async () => {
        const provider = makeProvider({
            getMergedOptions: vi.fn(() => ({
                model: undefined,
                modelParams: {},
                providerParams: { timeoutMs: 2222 },
                generalParams: {}
            }))
        });
        const moderate = vi.fn().mockResolvedValue({
            results: [
                {
                    categories: { violence: false, hate: 0 as any },
                    categoryScores: { violence: 0.01, hate: 0.02 }
                },
                {
                    categories: undefined,
                    categoryScores: undefined
                }
            ]
        });
        const cap = new MistralModerationCapabilityImpl(provider, { classifiers: { moderate } } as any);

        const response = await cap.moderation({
            input: { input: ["safe-1", "safe-2"] },
            context: { requestId: "moderation-array-1" }
        } as any);

        expect(response.output).toHaveLength(2);
        expect(response.output[0]?.flagged).toBe(false);
        expect(response.output[0]?.reason).toBeUndefined();
        expect(response.output[1]?.categories).toEqual({});
        expect(response.metadata?.model).toBe("mistral-moderation-latest");
        expect(moderate).toHaveBeenCalledWith(
            expect.objectContaining({
                model: "mistral-moderation-latest",
                inputs: ["safe-1", "safe-2"]
            }),
            expect.objectContaining({ timeoutMs: 2222 })
        );
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

    it("image analysis falls back to execution-context images and string output when JSON parsing yields no objects", async () => {
        const complete = vi.fn().mockResolvedValue({
            id: "img-string-1",
            model: "mistral-small-latest",
            choices: [{ message: { content: "A spreadsheet screenshot with quarterly revenue totals." } }]
        });
        const cap = new MistralImageAnalysisCapabilityImpl(makeProvider(), {
            chat: { complete }
        } as any);

        const executionContext = {
            getLatestImages: () => [
                { id: "ctx-drop", sourceType: "url", url: undefined, base64: undefined, mimeType: "image/png" },
                {
                    id: "ctx-keep",
                    sourceType: "base64",
                    base64: Buffer.from("ctx-image").toString("base64"),
                    mimeType: "image/png"
                }
            ]
        } as any;

        const response = await cap.analyzeImage(
            {
                input: { prompt: "Summarize the chart." },
                context: { requestId: "img-ctx-1" }
            } as any,
            executionContext
        );

        expect(response.output).toHaveLength(1);
        expect(response.output[0]?.description).toBe("A spreadsheet screenshot with quarterly revenue totals.");
        expect(response.output[0]?.sourceImageId).toBe("ctx-keep");
        expect(complete).toHaveBeenCalledWith(
            expect.objectContaining({
                messages: [
                    {
                        role: "user",
                        content: [
                            { type: "text", text: "Summarize the chart." },
                            {
                                type: "image_url",
                                imageUrl: expect.stringMatching(/^data:image\/png;base64,/)
                            }
                        ]
                    }
                ]
            }),
            expect.any(Object)
        );
    });

    it("image analysis stream emits incremental and terminal chunks from Mistral chat streaming", async () => {
        const cap = new MistralImageAnalysisCapabilityImpl(makeProvider(), {
            chat: {
                stream: vi.fn().mockResolvedValue({
                    async *[Symbol.asyncIterator]() {
                        yield {
                            data: {
                                id: "img-stream-1",
                                choices: [{ delta: { content: '[{"imageIndex":0,' } }]
                            }
                        };
                        yield {
                            data: {
                                id: "img-stream-1",
                                choices: [{ delta: { content: '"description":"streamed image"}]' } }]
                            }
                        };
                    }
                })
            }
        } as any);

        const chunks: any[] = [];
        for await (const chunk of cap.analyzeImageStream({
            input: { images: [{ id: "img-stream-source", sourceType: "url", url: "https://example.com/img.png" }] }
        } as any)) {
            chunks.push(chunk);
        }

        expect(chunks).toHaveLength(2);
        expect(chunks[0].done).toBe(false);
        expect(chunks[0].output?.[0]?.description).toBe("streamed image");
        expect(chunks[0].output?.[0]?.sourceImageId).toBe("img-stream-source");
        expect(chunks[1].done).toBe(true);
        expect(chunks[1].output?.[0]?.description).toBe("streamed image");
        expect(chunks[1].output?.[0]?.sourceImageId).toBe("img-stream-source");
    });

    it("image analysis stream skips incomplete and duplicate structured emissions", async () => {
        const cap = new MistralImageAnalysisCapabilityImpl(makeProvider(), {
            chat: {
                stream: vi.fn().mockResolvedValue({
                    async *[Symbol.asyncIterator]() {
                        yield {
                            data: {
                                id: "img-stream-dup-1",
                                choices: [{ delta: { content: '[{"imageIndex":0,"description":"same"}]' } }]
                            }
                        };
                        yield {
                            data: {
                                id: "img-stream-dup-1",
                                choices: [{ delta: { content: "" } }]
                            }
                        };
                        yield {
                            data: {
                                id: "img-stream-dup-1",
                                choices: [{ delta: { content: " " } }]
                            }
                        };
                    }
                })
            }
        } as any);

        const chunks = await collect(
            cap.analyzeImageStream({
                input: { images: [{ id: "img-stream-dup-source", sourceType: "url", url: "https://example.com/img.png" }] }
            } as any)
        );

        expect(chunks).toHaveLength(2);
        expect(chunks[0]?.done).toBe(false);
        expect(chunks[0]?.output?.[0]?.description).toBe("same");
        expect(chunks[1]?.done).toBe(true);
        expect(chunks[1]?.delta).toEqual([]);
    });

    it("image analysis stream emits a terminal error chunk on provider failure", async () => {
        const cap = new MistralImageAnalysisCapabilityImpl(makeProvider(), {
            chat: {
                stream: vi.fn().mockRejectedValue(new Error("image stream boom"))
            }
        } as any);

        const chunks: any[] = [];
        for await (const chunk of cap.analyzeImageStream({
            input: { images: [{ id: "img-stream-source", sourceType: "url", url: "https://example.com/img.png" }] }
        } as any)) {
            chunks.push(chunk);
        }

        expect(chunks).toHaveLength(1);
        expect(chunks[0]).toMatchObject({
            done: true,
            delta: [],
            output: [],
            metadata: {
                provider: "mistral",
                status: "error",
                error: "image stream boom"
            }
        });
    });

    it("image analysis stream validates missing images and pre-aborted requests", async () => {
        const cap = new MistralImageAnalysisCapabilityImpl(makeProvider(), {
            chat: {
                stream: vi.fn()
            }
        } as any);

        await expect(collect(cap.analyzeImageStream({ input: {} } as any))).rejects.toThrow(
            "At least one image is required for analysis"
        );

        const controller = new AbortController();
        controller.abort();
        await expect(
            collect(
                cap.analyzeImageStream(
                    {
                        input: { images: [{ id: "img-1", sourceType: "url", url: "https://example.com/img.png" }] }
                    } as any,
                    undefined,
                    controller.signal
                )
            )
        ).resolves.toEqual([]);
    });

    it("image analysis stream exits quietly on mid-stream abort and on setup failure after abort", async () => {
        const controller = new AbortController();
        const client = {
            chat: {
                stream: vi.fn()
                    .mockResolvedValueOnce({
                        async *[Symbol.asyncIterator]() {
                            yield {
                                data: {
                                    id: "img-stream-abort-1",
                                    choices: [{ delta: { content: '[{"imageIndex":0,"description":"first"}]' } }]
                                }
                            };
                            controller.abort();
                            yield {
                                data: {
                                    id: "img-stream-abort-1",
                                    choices: [{ delta: { content: '[{"imageIndex":0,"description":"second"}]' } }]
                                }
                            };
                        }
                    })
                    .mockImplementationOnce(async () => {
                        controller.abort();
                        throw new Error("late aborted image setup");
                    })
            }
        } as any;

        const cap = new MistralImageAnalysisCapabilityImpl(makeProvider(), client);

        const abortedDuringStream = await collect(
            cap.analyzeImageStream(
                {
                    input: { images: [{ id: "img-stream-source", sourceType: "url", url: "https://example.com/img.png" }] }
                } as any,
                undefined,
                controller.signal
            )
        );

        expect(abortedDuringStream.length).toBeLessThanOrEqual(1);
        if (abortedDuringStream[0]) {
            expect(abortedDuringStream[0]?.done).toBe(false);
            expect(abortedDuringStream[0]?.output?.[0]?.description).toBe("first");
        }

        controller.abort();
        const abortedDuringSetup = await collect(
            cap.analyzeImageStream(
                {
                    input: { images: [{ id: "img-stream-source-2", sourceType: "url", url: "https://example.com/img.png" }] }
                } as any,
                undefined,
                controller.signal
            )
        );

        expect(abortedDuringSetup).toEqual([]);
    });

    it("image analysis rejects missing images and aborted requests, and parses text chunks", async () => {
        const controller = new AbortController();
        controller.abort();
        const cap = new MistralImageAnalysisCapabilityImpl(makeProvider(), {
            chat: {
                complete: vi.fn().mockResolvedValue({
                    id: "img-chunks-1",
                    model: "mistral-small-latest",
                    choices: [
                        {
                            message: {
                                content: [
                                    { type: "text", text: '[{"imageIndex":0,' },
                                    { type: "text", text: '"description":"chunked output"}]' }
                                ]
                            }
                        }
                    ]
                })
            }
        } as any);

        await expect(cap.analyzeImage({ input: {} } as any)).rejects.toThrow("At least one image is required for analysis");
        await expect(
            cap.analyzeImage(
                { input: { images: [{ id: "img-1", sourceType: "url", url: "https://example.com/img.png" }] } } as any,
                undefined,
                controller.signal
            )
        ).rejects.toThrow("Image analysis aborted before request started");

        const response = await cap.analyzeImage({
            input: { images: [{ id: "img-2", sourceType: "url", url: "https://example.com/img.png" }] }
        } as any);
        expect(response.output[0]?.description).toBe("chunked output");
    });

    it("image analysis handles empty provider content", async () => {
        const cap = new MistralImageAnalysisCapabilityImpl(makeProvider(), {
            chat: {
                complete: vi.fn().mockResolvedValue({
                    id: "img-empty-1",
                    choices: [{ message: { content: undefined } }]
                })
            }
        } as any);

        const response = await cap.analyzeImage({
            input: { images: [{ id: "img-empty-source", sourceType: "url", url: "https://example.com/img.png" }] }
        } as any);

        expect(response.output).toHaveLength(1);
        expect(response.output[0]?.description).toBeUndefined();
        expect(response.output[0]?.sourceImageId).toBe("img-empty-source");
    });

    it("image analysis filters invalid object/text entries and falls back sourceImageId by index", async () => {
        const cap = new MistralImageAnalysisCapabilityImpl(makeProvider(), {
            chat: {
                complete: vi.fn().mockResolvedValue({
                    id: "img-filter-1",
                    model: undefined,
                    choices: [
                        {
                            message: {
                                content: JSON.stringify([
                                    {
                                        imageIndex: 4,
                                        description: "filtered output",
                                        tags: ["chart"],
                                        objects: [{ label: "" }, { label: "axis" }],
                                        text: [{ text: "" }, { text: "Revenue", confidence: 0.91 }],
                                        safety: undefined
                                    }
                                ])
                            }
                        }
                    ]
                })
            }
        } as any);

        const response = await cap.analyzeImage({
            input: {
                images: [{ id: "img-fallback-1", sourceType: "base64", base64: Buffer.from("img").toString("base64"), mimeType: "image/png" }]
            }
        } as any);

        expect(response.output[0]?.objects).toEqual([{ label: "axis" }]);
        expect(response.output[0]?.text).toEqual([{ text: "Revenue", confidence: 0.91 }]);
        expect(response.output[0]?.safety).toBeUndefined();
        expect(response.output[0]?.sourceImageId).toBe("img-fallback-1");
        expect(response.metadata?.model).toBe("mistral-small-latest");
    });

    it("image analysis helper branches handle mixed context images and default prompt building", () => {
        const cap = new MistralImageAnalysisCapabilityImpl(makeProvider(), { chat: { complete: vi.fn() } } as any);
        const helper = cap as any;

        expect(
            helper.toReferenceImages([
                { id: "url-image", url: "https://example.com/img.png", base64: undefined, mimeType: "image/png" },
                { id: "base64-image", url: undefined, base64: "AQID", mimeType: "image/png" },
                { id: "drop-image", url: undefined, base64: undefined, mimeType: "image/png" }
            ])
        ).toEqual([
            {
                id: "url-image",
                sourceType: "url",
                url: "https://example.com/img.png",
                base64: undefined,
                mimeType: "image/png"
            },
            {
                id: "base64-image",
                sourceType: "base64",
                url: undefined,
                base64: "AQID",
                mimeType: "image/png"
            }
        ]);

        expect(
            helper.buildImageAnalysisRequest(
                "mistral-small-latest",
                [
                    { id: "url-image", sourceType: "url", url: "https://example.com/img.png" },
                    { id: "base64-image", sourceType: "base64", base64: "AQID", mimeType: "image/png" }
                ],
                "Analyze these",
                undefined
            )
        ).toEqual(
            expect.objectContaining({
                model: "mistral-small-latest",
                responseFormat: { type: "json_object" },
                messages: [
                    {
                        role: "user",
                        content: [
                            { type: "text", text: "Analyze these" },
                            { type: "image_url", imageUrl: "https://example.com/img.png" },
                            { type: "image_url", imageUrl: expect.stringMatching(/^data:image\/png;base64,/) }
                        ]
                    }
                ]
            })
        );
    });

    it("ocr normalizes page markdown into OCR document output", async () => {
        const client = {
            ocr: {
                process: vi.fn().mockResolvedValue({
                    model: "mistral-ocr-latest",
                    documentAnnotation: "{\"docType\":\"worksheet\"}",
                    pages: [
                        {
                            index: 0,
                            markdown: "# Heading\nHello world",
                            images: [
                                {
                                    id: "img-anno-1",
                                    topLeftX: 0.1,
                                    topLeftY: 0.2,
                                    bottomRightX: 0.5,
                                    bottomRightY: 0.4,
                                    imageAnnotation: "Figure 1"
                                }
                            ],
                            dimensions: { dpi: 72, height: 1000, width: 800 },
                            header: "Top header",
                            footer: "Bottom footer",
                            hyperlinks: ["https://example.com"],
                            tables: [
                                {
                                    id: "table-1",
                                    content: "| a | b |",
                                    format: "markdown"
                                }
                            ]
                        }
                    ],
                    usageInfo: { pagesProcessed: 1, docSizeBytes: 1234 }
                })
            }
        } as any;

        const cap = new MistralOCRCapabilityImpl(makeProvider(), client);
        const response = await cap.ocr(
            {
                input: { file: "https://example.com/test.pdf", filename: "test.pdf", mimeType: "application/pdf", language: "en" },
                context: { requestId: "ocr-1" }
            } as any,
            {} as any
        );

        expect(response.output).toHaveLength(1);
        expect(response.output[0]?.pageCount).toBe(1);
        expect(response.output[0]?.fullText).toContain("Hello world");
        expect(response.output[0]?.pages?.[0]?.pageNumber).toBe(1);
        expect(response.output[0]?.pages?.[0]?.text?.[0]?.text).toContain("Heading");
        expect(response.output[0]?.annotations?.[0]?.type).toBe("document");
        expect(response.output[0]?.annotations?.[0]?.text).toBe("{\"docType\":\"worksheet\"}");
        expect(response.output[0]?.annotations?.[0]?.data).toEqual({ docType: "worksheet" });
        expect(response.output[0]?.annotations?.[1]?.type).toBe("bbox");
        expect(response.output[0]?.annotations?.[1]?.bbox).toEqual({ x: 0.1, y: 0.2, width: 0.4, height: 0.2 });
        expect(response.output[0]?.tables?.[0]?.format).toBe("markdown");
        expect(response.output[0]?.headers?.[0]?.text).toBe("Top header");
        expect(response.output[0]?.footers?.[0]?.text).toBe("Bottom footer");
        expect(response.output[0]?.rawDocumentMarkdown).toContain("# Heading");
        expect(response.multimodalArtifacts?.ocr).toHaveLength(1);
        expect(response.metadata?.provider).toBe("mistral");
    });

    it("ocr does not send documentAnnotationPrompt unless documentAnnotationFormat is configured", async () => {
        const process = vi.fn().mockResolvedValue({
            model: "mistral-ocr-latest",
            pages: [
                {
                    index: 0,
                    markdown: "hello",
                    images: [],
                    dimensions: null
                }
            ],
            usageInfo: { pagesProcessed: 1, docSizeBytes: 16 }
        });

        const cap = new MistralOCRCapabilityImpl(makeProvider(), { ocr: { process } } as any);
        await cap.ocr(
            {
                input: {
                    file: "https://example.com/test.pdf",
                    prompt: "Extract visible text and preserve line breaks."
                },
                context: { requestId: "ocr-2" }
            } as any,
            {} as any
        );

        expect(process).toHaveBeenCalledWith(
            expect.not.objectContaining({
                documentAnnotationPrompt: expect.any(String)
            }),
            expect.any(Object)
        );
    });

    it("ocr maps document options into mistral OCR request fields", async () => {
        const process = vi.fn().mockResolvedValue({
            model: "mistral-ocr-latest",
            pages: [
                {
                    index: 0,
                    markdown: "hello",
                    images: [],
                    dimensions: null
                }
            ],
            usageInfo: { pagesProcessed: 1, docSizeBytes: 16 }
        });

        const cap = new MistralOCRCapabilityImpl(makeProvider(), { ocr: { process } } as any);
        await cap.ocr(
            {
                input: {
                    file: "https://example.com/test.pdf",
                    structured: {
                        annotationMode: "document",
                        annotationPrompt: "Extract all assignments and due times.",
                        annotationSchema: {
                            name: "assignment_summary",
                            schema: {
                                type: "object",
                                properties: {
                                    title: { type: "string" }
                                },
                                required: ["title"]
                            }
                        },
                        tableFormat: "markdown",
                        extractHeaders: true,
                        extractFooters: true,
                        pages: [1]
                    }
                },
                context: { requestId: "ocr-3" }
            } as any,
            {} as any
        );

        expect(process).toHaveBeenCalledWith(
            expect.objectContaining({
                documentAnnotationFormat: expect.objectContaining({
                    type: "json_schema",
                    jsonSchema: expect.objectContaining({
                        name: "assignment_summary"
                    })
                }),
                documentAnnotationPrompt: "Extract all assignments and due times.",
                tableFormat: "markdown",
                extractHeader: true,
                extractFooter: true,
                pages: [0]
            }),
            expect.any(Object)
        );
    });

    it("ocr annotation modes require a schema for mistral", async () => {
        const cap = new MistralOCRCapabilityImpl(makeProvider(), {
            ocr: {
                process: vi.fn()
            }
        } as any);

        await expect(
            cap.ocr(
                {
                    input: {
                        file: "https://example.com/test.pdf",
                        structured: {
                            annotationMode: "document",
                            annotationPrompt: "Extract fields."
                        }
                    },
                    context: { requestId: "ocr-4" }
                } as any,
                {} as any
            )
        ).rejects.toThrow("structured.annotationSchema");
    });

    it("ocr region annotation mode also requires a schema for mistral", async () => {
        const cap = new MistralOCRCapabilityImpl(makeProvider(), {
            ocr: {
                process: vi.fn()
            }
        } as any);

        await expect(
            cap.ocr(
                {
                    input: {
                        file: "https://example.com/test.pdf",
                        structured: {
                            annotationMode: "regions",
                            annotationPrompt: "Extract labeled regions."
                        }
                    }
                } as any,
                {} as any
            )
        ).rejects.toThrow("Mistral OCR region annotations require structured.annotationSchema");
    });

    it("ocr aborts before execution and maps region annotation schema plus includeBoundingBoxes", async () => {
        const process = vi.fn().mockResolvedValue({
            model: "mistral-ocr-latest",
            pages: [{ index: 0, markdown: "hello", images: [], dimensions: null }],
            usageInfo: { pagesProcessed: 1, docSizeBytes: 16 }
        });

        const controller = new AbortController();
        controller.abort();
        const cap = new MistralOCRCapabilityImpl(makeProvider(), { ocr: { process } } as any);

        await expect(
            cap.ocr(
                {
                    input: {
                        file: "https://example.com/test.pdf"
                    }
                } as any,
                {} as any,
                controller.signal
            )
        ).rejects.toThrow("OCR request aborted before execution");

        const activeCap = new MistralOCRCapabilityImpl(makeProvider(), { ocr: { process } } as any);
        await activeCap.ocr(
            {
                input: {
                    file: "https://example.com/test.pdf",
                    includeBoundingBoxes: true,
                    structured: {
                        annotationMode: "regions",
                        annotationPrompt: "Extract labeled regions.",
                        annotationSchema: {
                            name: "region_schema",
                            description: "Region labels",
                            strict: true,
                            schema: {
                                type: "object",
                                properties: {
                                    label: { type: "string" }
                                }
                            }
                        },
                        tableFormat: "html"
                    }
                }
            } as any,
            {} as any
        );

        expect(process).toHaveBeenCalledWith(
            expect.objectContaining({
                bboxAnnotationFormat: expect.objectContaining({
                    type: "json_schema",
                    jsonSchema: expect.objectContaining({
                        name: "region_schema",
                        description: "Region labels",
                        strict: true
                    })
                }),
                tableFormat: "html",
                includeImageBase64: true
            }),
            expect.any(Object)
        );
    });

    it("ocr validates source cardinality and image payload requirements", async () => {
        const cap = new MistralOCRCapabilityImpl(makeProvider(), { ocr: { process: vi.fn() } } as any);

        await expect(cap.ocr({ input: {} } as any, {} as any)).rejects.toThrow("OCR requires either `file` or one image");
        await expect(
            cap.ocr(
                {
                    input: {
                        file: "https://example.com/test.pdf",
                        images: [{ id: "img", sourceType: "url", url: "https://example.com/img.png" }]
                    }
                } as any,
                {} as any
            )
        ).rejects.toThrow("provide either `file` or `images`, not both");
        await expect(
            cap.ocr(
                {
                    input: {
                        images: [
                            { id: "img-1", sourceType: "url", url: "https://example.com/1.png" },
                            { id: "img-2", sourceType: "url", url: "https://example.com/2.png" }
                        ]
                    }
                } as any,
                {} as any
            )
        ).rejects.toThrow("exactly one image per request");
        await expect(
            cap.ocr(
                {
                    input: {
                        images: [{ id: "img-empty", sourceType: "base64" }]
                    }
                } as any,
                {} as any
            )
        ).rejects.toThrow("Mistral OCR image inputs require either `url` or `base64`");
    });

    it("ocr routes data URI images directly and uploads non-image data URIs", async () => {
        const upload = vi.fn().mockResolvedValue({ id: "mistral-data-uri-123" });
        const process = vi
            .fn()
            .mockResolvedValueOnce({
                model: "mistral-ocr-latest",
                pages: [{ index: 0, markdown: "image", images: [], dimensions: null }],
                usageInfo: { pagesProcessed: 1, docSizeBytes: 8 }
            })
            .mockResolvedValueOnce({
                model: "mistral-ocr-latest",
                pages: [{ index: 0, markdown: "document", images: [], dimensions: null }],
                usageInfo: { pagesProcessed: 1, docSizeBytes: 8 }
            });

        const cap = new MistralOCRCapabilityImpl(makeProvider(), {
            files: { upload },
            ocr: { process }
        } as any);

        await cap.ocr(
            {
                input: {
                    file: "data:image/png;base64,AQID"
                }
            } as any,
            {} as any
        );

        await cap.ocr(
            {
                input: {
                    file: "data:text/plain;base64,SGVsbG8=",
                    mimeType: "text/plain"
                }
            } as any,
            {} as any
        );

        expect(process.mock.calls[0][0].document).toEqual({
            type: "image_url",
            imageUrl: "data:image/png;base64,AQID"
        });
        expect(process.mock.calls[1][0].document).toEqual({
            type: "file",
            fileId: "mistral-data-uri-123"
        });
        expect(upload).toHaveBeenCalledTimes(1);
        expect(upload.mock.calls[0][0].file.fileName).toBe("ocr-input");
    });

    it("ocr uploads unnamed blobs, stream inputs, and rejects invalid data URIs or unsupported input types", async () => {
        const upload = vi.fn().mockResolvedValue({ id: "mistral-blob-123" });
        const process = vi.fn().mockResolvedValue({
            model: "mistral-ocr-latest",
            pages: [{ index: 0, markdown: "hello", images: [], dimensions: null }],
            usageInfo: { pagesProcessed: 1, docSizeBytes: 8 }
        });

        const cap = new MistralOCRCapabilityImpl(makeProvider(), {
            files: { upload },
            ocr: { process }
        } as any);

        await cap.ocr(
            {
                input: {
                    file: new Blob([Buffer.from("blob-content")], { type: "" }),
                    mimeType: "application/rtf"
                }
            } as any,
            {} as any
        );

        await cap.ocr(
            {
                input: {
                    file: Readable.from([Buffer.from("ab"), "cd"]),
                    mimeType: "application/pdf"
                }
            } as any,
            {} as any
        );

        expect(upload.mock.calls[0][0].file.fileName).toBe("ocr-input.rtf");
        expect(upload.mock.calls[0][0].file.content).toBeInstanceOf(Blob);
        expect((upload.mock.calls[0][0].file.content as Blob).type).toBe("application/rtf");
        expect(upload.mock.calls[1][0].file.fileName).toBe("ocr-input.pdf");
        expect(upload.mock.calls[1][0].file.content).toBeInstanceOf(Uint8Array);

        await expect(
            cap.ocr(
                {
                    input: {
                        file: "data:text/plain;base64"
                    }
                } as any,
                {} as any
            )
        ).rejects.toThrow("Invalid data URL");

        await expect(
            cap.ocr(
                {
                    input: {
                        file: 42 as any
                    }
                } as any,
                {} as any
            )
        ).rejects.toThrow("Unsupported Mistral OCR input type");
    });

    it("ocr ignores invalid bounding boxes and supports inline table format and image-like URLs", async () => {
        const process = vi
            .fn()
            .mockResolvedValueOnce({
                model: "mistral-ocr-latest",
                pages: [
                    {
                        index: 0,
                        markdown: "hello",
                        images: [
                            {
                                id: "bad-bbox",
                                topLeftX: 0.5,
                                topLeftY: 0.5,
                                bottomRightX: 0.5,
                                bottomRightY: 0.7,
                                imageAnnotation: "Degenerate box"
                            }
                        ],
                        dimensions: null
                    }
                ],
                usageInfo: { pagesProcessed: 1, docSizeBytes: 16 }
            })
            .mockResolvedValueOnce({
                model: "mistral-ocr-latest",
                pages: [{ index: 0, markdown: "hello", images: [], dimensions: null }],
                usageInfo: { pagesProcessed: 1, docSizeBytes: 16 }
            });

        const cap = new MistralOCRCapabilityImpl(makeProvider(), { ocr: { process }, files: { upload: vi.fn() } } as any);

        const response = await cap.ocr(
            {
                input: {
                    file: "https://example.com/test.pdf",
                    structured: {
                        tableFormat: "inline"
                    }
                }
            } as any,
            {} as any
        );

        await cap.ocr(
            {
                input: {
                    file: "https://%zz/broken.jpg"
                }
            } as any,
            {} as any
        );

        expect(response.output[0]?.annotations?.[0]?.bbox).toBeUndefined();
        expect(process.mock.calls[0][0].tableFormat).toBeNull();
        expect(process.mock.calls[1][0].document).toEqual({
            type: "document_url",
            documentUrl: "https://%zz/broken.jpg"
        });
    });

    it("ocr drops unusable hyperlinks, non-numeric bounding boxes, and aborts while draining stream inputs", async () => {
        const upload = vi.fn().mockResolvedValue({ id: "mistral-stream-ocr-123" });
        const process = vi
            .fn()
            .mockResolvedValueOnce({
                model: "mistral-ocr-latest",
                pages: [
                    {
                        index: 0,
                        markdown: "Reference [broken](https://good.example.com/path...).\nBare: www.example.com/test,",
                        images: [
                            {
                                id: "non-numeric-bbox",
                                topLeftX: "left" as any,
                                topLeftY: 0.2,
                                bottomRightX: 0.6,
                                bottomRightY: 0.8,
                                imageAnnotation: "Bad coordinates"
                            }
                        ],
                        hyperlinks: [undefined as any, "..." as any, "https://valid.example.com/path)."],
                        dimensions: null
                    }
                ],
                usageInfo: { pagesProcessed: 1, docSizeBytes: 16 }
            });

        const cap = new MistralOCRCapabilityImpl(makeProvider(), {
            files: { upload },
            ocr: { process }
        } as any);

        const response = await cap.ocr(
            {
                input: {
                    file: "https://example.com/test.pdf"
                }
            } as any,
            {} as any
        );

        expect(response.output[0]?.annotations?.[0]?.bbox).toBeUndefined();
        expect(response.output[0]?.pages?.[0]?.metadata?.hyperlinks).toEqual([
            "https://valid.example.com/path",
            "https://good.example.com/path",
            "https://www.example.com/test"
        ]);

        const controller = new AbortController();
        const stream = Readable.from(
            (async function* () {
                yield Buffer.from("ab");
                controller.abort();
                yield "cd";
            })()
        );

        await expect(
            cap.ocr(
                {
                    input: {
                        file: stream,
                        mimeType: "application/pdf"
                    }
                } as any,
                {} as any,
                controller.signal
            )
        ).rejects.toThrow("OCR request aborted while reading stream input");
    });

    it("ocr handles empty markdown, non-table pipe lines, and non-string helper guards", async () => {
        const cap = new MistralOCRCapabilityImpl(makeProvider(), {
            ocr: {
                process: vi.fn().mockResolvedValue({
                    model: "mistral-ocr-latest",
                    pages: [
                        {
                            index: 0,
                            markdown: null,
                            images: [],
                            hyperlinks: undefined,
                            dimensions: null
                        },
                        {
                            index: 1,
                            markdown: "Value A | Value B\nplain text line",
                            images: [],
                            hyperlinks: [],
                            dimensions: null
                        }
                    ],
                    usageInfo: { pagesProcessed: 2, docSizeBytes: 24 }
                })
            }
        } as any);

        const response = await cap.ocr(
            {
                input: {
                    file: "https://example.com/two-page.pdf"
                }
            } as any,
            {} as any
        );

        expect(response.output[0]?.pages?.[0]?.fullText).toBeUndefined();
        expect(response.output[0]?.pages?.[1]?.fullText).toContain("Value A | Value B");
        expect(response.output[0]?.pages?.[1]?.fullText).toContain("plain text line");
        expect(response.output[0]?.rawDocumentMarkdown).toContain("Value A | Value B");
    });

    it("ocr leaves invalid document annotations unparsed and ignores unsupported table entries", async () => {
        const cap = new MistralOCRCapabilityImpl(makeProvider(), {
            ocr: {
                process: vi.fn().mockResolvedValue({
                    model: "mistral-ocr-latest",
                    documentAnnotation: "{invalid-json",
                    pages: [
                        {
                            index: 0,
                            markdown: "| not a table",
                            images: [],
                            dimensions: null,
                            tables: [
                                { format: "csv", content: "a,b" } as any,
                                { format: "markdown", content: "   " } as any,
                                { format: "html", content: "<table><tr><td>x</td></tr></table>" }
                            ]
                        }
                    ],
                    usageInfo: { pagesProcessed: 1, docSizeBytes: 16 }
                })
            }
        } as any);

        const response = await cap.ocr(
            {
                input: { file: "https://example.com/annotation.pdf" }
            } as any,
            {} as any
        );

        expect(response.output[0]?.annotations?.[0]?.text).toBe("{invalid-json");
        expect(response.output[0]?.annotations?.[0]?.data).toBeUndefined();
        expect(response.output[0]?.tables).toEqual([
            {
                pageNumber: 1,
                format: "html",
                content: "<table><tr><td>x</td></tr></table>"
            }
        ]);
        expect(response.output[0]?.pages?.[0]?.fullText).toContain("not a table");
    });

    it("ocr keeps array annotations, drops primitive annotations, and normalizes non-separator pipe rows", async () => {
        const cap = new MistralOCRCapabilityImpl(makeProvider(), {
            ocr: {
                process: vi
                    .fn()
                    .mockResolvedValueOnce({
                        model: "mistral-ocr-latest",
                        documentAnnotation: "[{\"field\":\"value\"}]",
                        pages: [
                            {
                                index: 0,
                                markdown: "alpha | beta\n| value only",
                                images: [],
                                dimensions: null,
                                tables: undefined,
                                header: undefined,
                                footer: undefined
                            }
                        ],
                        usageInfo: { pagesProcessed: 1, docSizeBytes: 10 }
                    })
                    .mockResolvedValueOnce({
                        model: "mistral-ocr-latest",
                        documentAnnotation: "7",
                        pages: [
                            {
                                index: 0,
                                markdown: "",
                                images: [],
                                dimensions: null,
                                tables: undefined,
                                header: undefined,
                                footer: undefined
                            }
                        ],
                        usageInfo: { pagesProcessed: 1, docSizeBytes: 10 }
                    })
            }
        } as any);

        const arrayAnnotationResponse = await cap.ocr(
            {
                input: { file: "https://example.com/annotation-array.pdf" }
            } as any,
            {} as any
        );

        const primitiveAnnotationResponse = await cap.ocr(
            {
                input: { file: "https://example.com/annotation-primitive.pdf" }
            } as any,
            {} as any
        );

        expect(arrayAnnotationResponse.output[0]?.annotations?.[0]?.data).toEqual([{ field: "value" }]);
        expect(arrayAnnotationResponse.output[0]?.pages?.[0]?.fullText).toContain("alpha | beta");
        expect(arrayAnnotationResponse.output[0]?.pages?.[0]?.fullText).toContain("value only");
        expect(primitiveAnnotationResponse.output[0]?.annotations?.[0]?.data).toBeUndefined();
    });

    it("ocr helper branches cover arraybuffer uploads and markdown guard helpers", async () => {
        const upload = vi.fn().mockResolvedValue({ id: "mistral-arraybuffer-ocr-1" });
        const process = vi.fn().mockResolvedValue({
            model: "mistral-ocr-latest",
            pages: [
                {
                    index: 0,
                    markdown: "",
                    images: [{ id: "skip-empty", imageAnnotation: "   " }],
                    dimensions: null
                }
            ],
            usageInfo: { pagesProcessed: 1, docSizeBytes: 8 }
        });
        const cap = new MistralOCRCapabilityImpl(makeProvider(), {
            files: { upload },
            ocr: { process }
        } as any);
        const helper = cap as any;

        await cap.ocr(
            {
                input: {
                    file: new Uint8Array([1, 2, 3]).buffer,
                    mimeType: "application/pdf"
                }
            } as any,
            {} as any
        );

        expect(upload).toHaveBeenCalledWith(
            expect.objectContaining({
                file: expect.objectContaining({
                    fileName: "ocr-input.pdf",
                    content: expect.any(Uint8Array)
                })
            }),
            expect.any(Object)
        );
        expect(process.mock.calls[0][0].document).toEqual({ type: "file", fileId: "mistral-arraybuffer-ocr-1" });
        expect(normalizeOCRMarkdownTableOutput(undefined)).toBe("");
        expect(extractReadableTextFromOCRMarkdown("| --- | --- |")).toBe("");
        expect(tryParseAnnotationJson("7")).toBeUndefined();
        expect(tryParseAnnotationJson("{invalid")).toBeUndefined();
    });

    it("ocr routes url/base64 images, uploads Uint8Array, and aborts after readFile resolves", async () => {
        const upload = vi.fn().mockResolvedValue({ id: "mistral-ocr-branch-1" });
        const process = vi
            .fn()
            .mockResolvedValueOnce({
                model: "mistral-ocr-latest",
                pages: [{ index: 0, markdown: "url image", images: [], dimensions: null }],
                usageInfo: { pagesProcessed: 1, docSizeBytes: 8 }
            })
            .mockResolvedValueOnce({
                model: "mistral-ocr-latest",
                pages: [{ index: 0, markdown: "base64 image", images: [], dimensions: null }],
                usageInfo: { pagesProcessed: 1, docSizeBytes: 8 }
            })
            .mockResolvedValueOnce({
                model: "mistral-ocr-latest",
                pages: [{ index: 0, markdown: "uint8", images: [], dimensions: null }],
                usageInfo: { pagesProcessed: 1, docSizeBytes: 8 }
            });

        const cap = new MistralOCRCapabilityImpl(makeProvider(), {
            files: { upload },
            ocr: { process }
        } as any);

        await cap.ocr(
            {
                input: {
                    images: [{ id: "url-img", sourceType: "url", url: "https://example.com/ocr-image.png" }]
                }
            } as any,
            {} as any
        );

        await cap.ocr(
            {
                input: {
                    images: [{ id: "base64-img", sourceType: "base64", base64: "AQID", mimeType: "image/png" }]
                }
            } as any,
            {} as any
        );

        await cap.ocr(
            {
                input: {
                    file: new Uint8Array([1, 2, 3]),
                    mimeType: "application/pdf"
                }
            } as any,
            {} as any
        );

        expect(process.mock.calls[0][0].document).toEqual({
            type: "image_url",
            imageUrl: "https://example.com/ocr-image.png"
        });
        expect(process.mock.calls[1][0].document).toEqual({
            type: "image_url",
            imageUrl: expect.stringMatching(/^data:image\/png;base64,/)
        });
        expect(upload.mock.calls.at(-1)?.[0].file.content).toBeInstanceOf(Uint8Array);

        const actualFsPromises = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
        const controller = new AbortController();
        vi.resetModules();
        vi.doMock("node:fs/promises", async () => ({
            ...actualFsPromises,
            readFile: vi.fn(async (...args: Parameters<typeof actualFsPromises.readFile>) => {
                const result = await actualFsPromises.readFile(...args);
                controller.abort();
                return result;
            })
        }));

        const { MistralOCRCapabilityImpl: MockedOCRImpl } = await import(
            "#root/providers/mistral/capabilities/MistralOCRCapabilityImpl.js"
        );
        const mockedCap = new MockedOCRImpl(makeProvider(), {
            files: { upload: vi.fn() },
            ocr: { process: vi.fn() }
        } as any);
        const tempPath = makeTempFile("ocr-post-read-abort.pdf", "%PDF-1.7 abort");

        try {
            await expect(
                mockedCap.ocr(
                    {
                        input: {
                            file: tempPath,
                            mimeType: "application/pdf"
                        }
                    } as any,
                    {} as any,
                    controller.signal
                )
            ).rejects.toThrow("OCR request aborted while reading file input");
        } finally {
            vi.doUnmock("node:fs/promises");
            vi.resetModules();
            fs.rmSync(tempPath, { force: true });
        }
    });

    it("ocr uploads local PDFs and uses file-backed OCR request content", async () => {
        const upload = vi.fn().mockResolvedValue({ id: "mistral-file-123" });
        const process = vi.fn().mockResolvedValue({
            model: "mistral-ocr-latest",
            pages: [
                {
                    index: 0,
                    markdown: "hello",
                    images: [],
                    dimensions: null
                }
            ],
            usageInfo: { pagesProcessed: 1, docSizeBytes: 16 }
        });

        const cap = new MistralOCRCapabilityImpl(
            makeProvider(),
            {
                files: { upload },
                ocr: { process }
            } as any
        );

        await cap.ocr(
            {
                input: {
                    file: Buffer.from("%PDF-1.7 fake pdf bytes"),
                    filename: "doc.pdf",
                    mimeType: "application/pdf"
                },
                context: { requestId: "ocr-pdf-route-1" }
            } as any,
            {} as any
        );

        expect(upload).toHaveBeenCalledTimes(1);
        expect(upload.mock.calls[0][0].purpose).toBe("ocr");
        expect(upload.mock.calls[0][0].file.fileName).toBe("doc.pdf");
        expect(process.mock.calls[0][0].document).toEqual({
            type: "file",
            fileId: "mistral-file-123"
        });
    });

    it("ocr uploads local DOCX inputs with a docx filename when only mimeType is provided", async () => {
        const upload = vi.fn().mockResolvedValue({ id: "mistral-docx-123" });
        const process = vi.fn().mockResolvedValue({
            model: "mistral-ocr-latest",
            pages: [
                {
                    index: 0,
                    markdown: "hello",
                    images: [],
                    dimensions: null
                }
            ],
            usageInfo: { pagesProcessed: 1, docSizeBytes: 16 }
        });

        const cap = new MistralOCRCapabilityImpl(
            makeProvider(),
            {
                files: { upload },
                ocr: { process }
            } as any
        );

        await cap.ocr(
            {
                input: {
                    file: Buffer.from("fake-docx-bytes"),
                    mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                },
                context: { requestId: "ocr-docx-route-1" }
            } as any,
            {} as any
        );

        expect(upload).toHaveBeenCalledTimes(1);
        expect(upload.mock.calls[0][0].file.fileName).toBe("ocr-input.docx");
        expect(process.mock.calls[0][0].document).toEqual({
            type: "file",
            fileId: "mistral-docx-123"
        });
    });

    it("ocr uses document_url for remote DOCX documents", async () => {
        const process = vi.fn().mockResolvedValue({
            model: "mistral-ocr-latest",
            pages: [
                {
                    index: 0,
                    markdown: "hello",
                    images: [],
                    dimensions: null
                }
            ],
            usageInfo: { pagesProcessed: 1, docSizeBytes: 16 }
        });

        const cap = new MistralOCRCapabilityImpl(makeProvider(), { ocr: { process } } as any);
        await cap.ocr(
            {
                input: {
                    file: "https://example.com/test.docx",
                    mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                },
                context: { requestId: "ocr-docx-route-2" }
            } as any,
            {} as any
        );

        expect(process.mock.calls[0][0].document).toEqual({
            type: "document_url",
            documentUrl: "https://example.com/test.docx"
        });
    });

    it("ocr uploads local PPTX inputs with a pptx filename when only mimeType is provided", async () => {
        const upload = vi.fn().mockResolvedValue({ id: "mistral-pptx-123" });
        const process = vi.fn().mockResolvedValue({
            model: "mistral-ocr-latest",
            pages: [
                {
                    index: 0,
                    markdown: "hello",
                    images: [],
                    dimensions: null
                }
            ],
            usageInfo: { pagesProcessed: 1, docSizeBytes: 16 }
        });

        const cap = new MistralOCRCapabilityImpl(
            makeProvider(),
            {
                files: { upload },
                ocr: { process }
            } as any
        );

        await cap.ocr(
            {
                input: {
                    file: Buffer.from("fake-pptx-bytes"),
                    mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation"
                },
                context: { requestId: "ocr-pptx-route-1" }
            } as any,
            {} as any
        );

        expect(upload).toHaveBeenCalledTimes(1);
        expect(upload.mock.calls[0][0].file.fileName).toBe("ocr-input.pptx");
        expect(process.mock.calls[0][0].document).toEqual({
            type: "file",
            fileId: "mistral-pptx-123"
        });
    });

    it("ocr uses document_url for remote PPTX documents", async () => {
        const process = vi.fn().mockResolvedValue({
            model: "mistral-ocr-latest",
            pages: [
                {
                    index: 0,
                    markdown: "hello",
                    images: [],
                    dimensions: null
                }
            ],
            usageInfo: { pagesProcessed: 1, docSizeBytes: 16 }
        });

        const cap = new MistralOCRCapabilityImpl(makeProvider(), { ocr: { process } } as any);
        await cap.ocr(
            {
                input: {
                    file: "https://example.com/test.pptx",
                    mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation"
                },
                context: { requestId: "ocr-pptx-route-2" }
            } as any,
            {} as any
        );

        expect(process.mock.calls[0][0].document).toEqual({
            type: "document_url",
            documentUrl: "https://example.com/test.pptx"
        });
    });

    it("exports Mistral OCR format support buckets", () => {
        expect(MISTRAL_OCR_FORMATS.tested.map((format) => format.extension)).toEqual(
            expect.arrayContaining(["png", "jpg", "jpeg", "webp", "gif", "bmp", "tiff", "heic", "heif", "pdf", "docx", "pptx", "odt", "xlsx"])
        );
        expect(MISTRAL_OCR_FORMATS.documented.map((format) => format.extension)).toEqual(expect.arrayContaining(["avif"]));
        expect(MISTRAL_OCR_FORMATS.experimental.map((format) => format.extension)).toEqual(
            expect.arrayContaining(["jpe", "jfif", "tif", "rtf"])
        );
    });

    it("ocr uses registry-backed upload extensions for documented and tested Mistral formats", async () => {
        const upload = vi.fn().mockResolvedValue({ id: "mistral-format-registry-123" });
        const process = vi.fn().mockResolvedValue({
            model: "mistral-ocr-latest",
            pages: [
                {
                    index: 0,
                    markdown: "hello",
                    images: [],
                    dimensions: null
                }
            ],
            usageInfo: { pagesProcessed: 1, docSizeBytes: 16 }
        });

        const cap = new MistralOCRCapabilityImpl(
            makeProvider(),
            {
                files: { upload },
                ocr: { process }
            } as any
        );

        await cap.ocr(
            {
                input: {
                    file: Buffer.from("fake-avif-bytes"),
                    mimeType: "image/avif"
                },
                context: { requestId: "ocr-format-registry-avif" }
            } as any,
            {} as any
        );

        await cap.ocr(
            {
                input: {
                    file: Buffer.from("fake-odt-bytes"),
                    mimeType: "application/vnd.oasis.opendocument.text"
                },
                context: { requestId: "ocr-format-registry-odt" }
            } as any,
            {} as any
        );

        expect(upload.mock.calls[0][0].file.fileName).toBe("ocr-input.avif");
        expect(upload.mock.calls[1][0].file.fileName).toBe("ocr-input.odt");
    });

    it("ocr uses registry-backed upload extensions for raster image formats and experimental document formats", async () => {
        const upload = vi.fn().mockResolvedValue({ id: "mistral-format-registry-456" });
        const process = vi.fn().mockResolvedValue({
            model: "mistral-ocr-latest",
            pages: [
                {
                    index: 0,
                    markdown: "hello",
                    images: [],
                    dimensions: null
                }
            ],
            usageInfo: { pagesProcessed: 1, docSizeBytes: 16 }
        });

        const cap = new MistralOCRCapabilityImpl(
            makeProvider(),
            {
                files: { upload },
                ocr: { process }
            } as any
        );

        const cases = [
            { mimeType: "image/webp", expected: "ocr-input.webp" },
            { mimeType: "image/gif", expected: "ocr-input.gif" },
            { mimeType: "image/bmp", expected: "ocr-input.bmp" },
            { mimeType: "image/tiff", expected: "ocr-input.tif" },
            { mimeType: "image/heic", expected: "ocr-input.heic" },
            { mimeType: "image/heif", expected: "ocr-input.heif" },
            { mimeType: "application/rtf", expected: "ocr-input.rtf" },
            { mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", expected: "ocr-input.xlsx" }
        ] as const;

        for (const [index, testCase] of cases.entries()) {
            await cap.ocr(
                {
                    input: {
                        file: Buffer.from(`fake-format-${index}`),
                        mimeType: testCase.mimeType
                    },
                    context: { requestId: `ocr-format-registry-extra-${index}` }
                } as any,
                {} as any
            );
        }

        expect(upload.mock.calls.map((call) => call[0].file.fileName)).toEqual(cases.map((testCase) => testCase.expected));
    });

    it("ocr preserves caller MIME for path-backed plain text uploads", async () => {
        const upload = vi.fn().mockResolvedValue({ id: "mistral-path-text-123" });
        const process = vi.fn().mockResolvedValue({
            model: "mistral-ocr-latest",
            pages: [
                {
                    index: 0,
                    markdown: "hello",
                    images: [],
                    dimensions: null
                }
            ],
            usageInfo: { pagesProcessed: 1, docSizeBytes: 16 }
        });
        const filePath = makeTempFile("plain-text-fixture.txt", "Title: Sample\nBody: plain text content.");

        try {
            const cap = new MistralOCRCapabilityImpl(
                makeProvider(),
                {
                    files: { upload },
                    ocr: { process }
                } as any
            );

            await cap.ocr(
                {
                    input: {
                        file: filePath,
                        mimeType: "text/plain"
                    },
                    context: { requestId: "ocr-path-text-plain" }
                } as any,
                {} as any
            );

            const uploadedFile = upload.mock.calls[0][0].file;
            expect(uploadedFile.fileName).toMatch(/plain-text-fixture\.txt$/);
            expect(uploadedFile.content).toBeInstanceOf(Blob);
            expect(uploadedFile.content.type).toBe("text/plain");
        } finally {
            fs.rmSync(filePath, { force: true });
        }
    });

    it("ocr preserves caller MIME for path-backed json uploads", async () => {
        const upload = vi.fn().mockResolvedValue({ id: "mistral-path-json-123" });
        const process = vi.fn().mockResolvedValue({
            model: "mistral-ocr-latest",
            pages: [
                {
                    index: 0,
                    markdown: "hello",
                    images: [],
                    dimensions: null
                }
            ],
            usageInfo: { pagesProcessed: 1, docSizeBytes: 16 }
        });
        const filePath = makeTempFile("payload.json", "{\"name\":\"fixture\"}");

        try {
            const cap = new MistralOCRCapabilityImpl(
                makeProvider(),
                {
                    files: { upload },
                    ocr: { process }
                } as any
            );

            await cap.ocr(
                {
                    input: {
                        file: filePath,
                        mimeType: "application/json"
                    },
                    context: { requestId: "ocr-path-json" }
                } as any,
                {} as any
            );

            const uploadedFile = upload.mock.calls[0][0].file;
            expect(uploadedFile.fileName).toMatch(/payload\.json$/);
            expect(uploadedFile.content).toBeInstanceOf(Blob);
            expect(uploadedFile.content.type).toBe("application/json");
        } finally {
            fs.rmSync(filePath, { force: true });
        }
    });

    it("ocr strips markdown-only image and table scaffolding from fullText", async () => {
        const cap = new MistralOCRCapabilityImpl(makeProvider(), {
            ocr: {
                process: vi.fn().mockResolvedValue({
                    model: "mistral-ocr-latest",
                    pages: [
                        {
                            index: 0,
                            markdown: "| ![img-0.jpeg](img-0.jpeg) |   |   |\n| --- | --- | --- |",
                            images: [],
                            dimensions: null
                        }
                    ],
                    usageInfo: { pagesProcessed: 1, docSizeBytes: 32 }
                })
            }
        } as any);

        const response = await cap.ocr(
            {
                input: { file: "https://example.com/test.png", mimeType: "image/png" },
                context: { requestId: "ocr-3" }
            } as any,
            {} as any
        );

        expect(response.output[0]?.fullText).toBeUndefined();
        expect(response.output[0]?.pages?.[0]?.fullText).toBeUndefined();
        expect(response.output[0]?.pages?.[0]?.metadata?.markdown).toContain("img-0.jpeg");
    });

    it("ocr trims trailing empty spreadsheet table rows from normalized markdown and fullText", async () => {
        const cap = new MistralOCRCapabilityImpl(makeProvider(), {
            ocr: {
                process: vi.fn().mockResolvedValue({
                    model: "mistral-ocr-latest",
                    pages: [
                        {
                            index: 0,
                            markdown:
                                "| SR | NAME |\n" +
                                "| --- | --- |\n" +
                                "| 1 | Dett |\n" +
                                "| 2 | Nern |\n" +
                                "|  |   |\n" +
                                "|  |   |",
                            images: [],
                            dimensions: null,
                            tables: [
                                {
                                    id: "table-1",
                                    format: "markdown",
                                    content:
                                        "| SR | NAME |\n" +
                                        "| --- | --- |\n" +
                                        "| 1 | Dett |\n" +
                                        "| 2 | Nern |\n" +
                                        "|  |   |\n" +
                                        "|  |   |"
                                }
                            ]
                        }
                    ],
                    usageInfo: { pagesProcessed: 1, docSizeBytes: 64 }
                })
            }
        } as any);

        const response = await cap.ocr(
            {
                input: {
                    file: "https://example.com/test.xlsx",
                    mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                },
                context: { requestId: "ocr-xlsx-trailing-empty-rows-1" }
            } as any,
            {} as any
        );

        expect(response.output[0]?.rawDocumentMarkdown).toContain("|  |   |");
        expect(response.output[0]?.pages?.[0]?.metadata?.markdown).not.toContain("|  |   |");
        expect(response.output[0]?.pages?.[0]?.fullText).toContain("SR NAME");
        expect(response.output[0]?.pages?.[0]?.fullText).toContain("1 Dett");
        expect(response.output[0]?.pages?.[0]?.fullText).toContain("2 Nern");
        expect(response.output[0]?.tables?.[0]?.content).not.toContain("|  |   |");
        expect(response.output[0]?.tables?.[0]?.content).toContain("| 2 | Nern |");
    });

    it("ocr unescapes readable markdown punctuation and recovers hyperlinks from markdown when missing", async () => {
        const cap = new MistralOCRCapabilityImpl(makeProvider(), {
            ocr: {
                process: vi.fn().mockResolvedValue({
                    model: "mistral-ocr-latest",
                    pages: [
                        {
                            index: 0,
                            markdown:
                                "# __Fixture__\n" +
                                "Slide 1 \\\\- title\\\\, subtitle\\\\, and date 2026\\\\-03\\\\-29\n" +
                                "[Portfolio: https://www\\\\.lboydstun\\\\.com](https://www.lboydstun.com)\n" +
                                "Email: lauren\\\\.emily\\\\.boydstun@gmail\\\\.com",
                            images: [],
                            hyperlinks: [],
                            dimensions: null
                        }
                    ],
                    usageInfo: { pagesProcessed: 1, docSizeBytes: 64 }
                })
            }
        } as any);

        const response = await cap.ocr(
            {
                input: { file: "https://example.com/test.pptx", mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation" },
                context: { requestId: "ocr-escaped-markdown-1" }
            } as any,
            {} as any
        );

        expect(response.output[0]?.pages?.[0]?.fullText).toContain("Fixture");
        expect(response.output[0]?.pages?.[0]?.fullText).not.toContain("# ");
        expect(response.output[0]?.pages?.[0]?.fullText).not.toContain("__Fixture__");
        expect(response.output[0]?.pages?.[0]?.fullText).toContain("Slide 1 - title, subtitle, and date 2026-03-29");
        expect(response.output[0]?.pages?.[0]?.fullText).toContain("Portfolio: https://www.lboydstun.com");
        expect(response.output[0]?.pages?.[0]?.fullText).toContain("Email: lauren.emily.boydstun@gmail.com");
        expect(response.output[0]?.pages?.[0]?.metadata?.hyperlinks).toEqual(["https://www.lboydstun.com"]);
        expect(response.output[0]?.rawDocumentMarkdown).toContain("# __Fixture__");
        expect(response.output[0]?.rawDocumentMarkdown).toContain("__Fixture__");
        expect(response.output[0]?.rawDocumentMarkdown).toContain("\\\\.");
    });

    it("ocr keeps malformed markdown table rows readable in normalized fullText", async () => {
        const cap = new MistralOCRCapabilityImpl(makeProvider(), {
            ocr: {
                process: vi.fn().mockResolvedValue({
                    model: "mistral-ocr-latest",
                    pages: [
                        {
                            index: 0,
                            markdown:
                                "| SR | NAME | COUNTRY |\n" +
                                "| --- | --- | --- |\n" +
                                "| 1 | Dett | Great Britain\n" +
                                "2 | Nern | France |\n" +
                                "| 3 | Kallsie | United States |",
                            images: [],
                            dimensions: null
                        }
                    ],
                    usageInfo: { pagesProcessed: 1, docSizeBytes: 96 }
                })
            }
        } as any);

        const response = await cap.ocr(
            {
                input: {
                    file: "https://example.com/malformed.xlsx",
                    mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                },
                context: { requestId: "ocr-malformed-table-1" }
            } as any,
            {} as any
        );

        const fullText = response.output[0]?.pages?.[0]?.fullText ?? "";
        expect(fullText).toContain("SR NAME COUNTRY");
        expect(fullText).toContain("1 Dett Great Britain");
        expect(fullText).toContain("2 Nern France");
        expect(fullText).toContain("3 Kallsie United States");
    });

    it("ocr merges provider, markdown, autolink, and bare-url hyperlinks", async () => {
        const cap = new MistralOCRCapabilityImpl(makeProvider(), {
            ocr: {
                process: vi.fn().mockResolvedValue({
                    model: "mistral-ocr-latest",
                    pages: [
                        {
                            index: 0,
                            markdown:
                                "Docs: [Reference](https://docs.example.com/path)\n" +
                                "Site: <https://status.example.com/page>\n" +
                                "Blog: www.example.com/blog\n" +
                                "Escaped: https://www\\\\.lboydstun\\\\.com/work",
                            images: [],
                            hyperlinks: ["https://provider.example.com/root"],
                            dimensions: null
                        }
                    ],
                    usageInfo: { pagesProcessed: 1, docSizeBytes: 96 }
                })
            }
        } as any);

        const response = await cap.ocr(
            {
                input: { file: "https://example.com/test.pdf", mimeType: "application/pdf" },
                context: { requestId: "ocr-hyperlink-merge-1" }
            } as any,
            {} as any
        );

        expect(response.output[0]?.pages?.[0]?.metadata?.hyperlinks).toEqual([
            "https://provider.example.com/root",
            "https://docs.example.com/path",
            "https://status.example.com/page",
            "https://www.example.com/blog",
            "https://www.lboydstun.com/work"
        ]);
        expect(response.output[0]?.pages?.[0]?.fullText).toContain("Reference: https://docs.example.com/path");
        expect(response.output[0]?.pages?.[0]?.fullText).toContain("https://status.example.com/page");
    });

    it("ocr preserves large spreadsheet-like outputs without trailing placeholder rows", async () => {
        const rows = Array.from({ length: 250 }, (_value, index) => `| ${index + 1} | Name ${index + 1} | Country ${index + 1} |`);
        const markdown = ["| SR | NAME | COUNTRY |", "| --- | --- | --- |", ...rows, "|  |  |  |", "|  |  |  |"].join("\n");

        const cap = new MistralOCRCapabilityImpl(makeProvider(), {
            ocr: {
                process: vi.fn().mockResolvedValue({
                    model: "mistral-ocr-latest",
                    pages: [
                        {
                            index: 0,
                            markdown,
                            images: [],
                            dimensions: null,
                            tables: [
                                {
                                    id: "table-large-1",
                                    format: "markdown",
                                    content: markdown
                                }
                            ]
                        }
                    ],
                    usageInfo: { pagesProcessed: 1, docSizeBytes: 4096 }
                })
            }
        } as any);

        const response = await cap.ocr(
            {
                input: {
                    file: "https://example.com/large.xlsx",
                    mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                },
                context: { requestId: "ocr-large-xlsx-1" }
            } as any,
            {} as any
        );

        const fullText = response.output[0]?.pages?.[0]?.fullText ?? "";
        expect(fullText).toContain("1 Name 1 Country 1");
        expect(fullText).toContain("250 Name 250 Country 250");
        expect(fullText).not.toContain("|  |  |  |");
        expect(response.output[0]?.tables?.[0]?.content).not.toContain("|  |  |  |");
        expect((fullText.match(/Name /g) ?? []).length).toBe(250);
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
