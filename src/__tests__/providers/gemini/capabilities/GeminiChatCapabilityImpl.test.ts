import { describe, expect, it, vi } from "vitest";
import { GeminiChatCapabilityImpl } from "#root/providers/gemini/capabilities/GeminiChatCapabilityImpl.js";

function makeProvider() {
    return {
        ensureInitialized: vi.fn(),
        getMergedOptions: vi.fn(() => ({
            model: "gemini-2.5-flash-latest",
            modelParams: {},
            providerParams: {},
            generalParams: { chatStreamBatchSize: 3 }
        }))
    } as any;
}

describe("GeminiChatCapabilityImpl", () => {
    it("throws for missing input messages in chat and stream", async () => {
        const cap = new GeminiChatCapabilityImpl(makeProvider(), { models: {} } as any);
        await expect(cap.chat({ input: {} } as any)).rejects.toThrow("Received empty input messages");
        await expect(cap.chatStream({ input: {} } as any).next()).rejects.toThrow("Received empty input messages");
    });

    it("chat normalizes response and usage metadata", async () => {
        const client = {
            models: {
                generateContent: vi.fn().mockResolvedValue({
                    text: "hello world",
                    responseId: "r1",
                    usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 4, totalTokenCount: 6 }
                })
            }
        };

        const cap = new GeminiChatCapabilityImpl(makeProvider(), client as any);
        const res = await cap.chat({
            input: { messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] },
            context: { requestId: "rq", metadata: { trace: "t" } }
        } as any);

        expect(res.id).toBe("r1");
        expect(res.output.role).toBe("assistant");
        expect(res.output.content[0]).toMatchObject({ type: "text", text: "hello world" });
        expect(res.metadata?.provider).toBe("gemini");
        expect(res.metadata?.inputTokens).toBe(2);
        expect(res.metadata?.totalTokens).toBe(6);
    });

    it("chat omits usage fields when provider usage metadata is absent", async () => {
        const client = {
            models: {
                generateContent: vi.fn().mockResolvedValue({
                    text: "hello world",
                    responseId: "r2"
                })
            }
        };

        const cap = new GeminiChatCapabilityImpl(makeProvider(), client as any);
        const res = await cap.chat({
            input: { messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] }
        } as any);

        expect(res.metadata?.inputTokens).toBeUndefined();
        expect(res.metadata?.outputTokens).toBeUndefined();
        expect(res.metadata?.totalTokens).toBeUndefined();
    });

    it("chat strips models/ prefix and allows empty assistant text", async () => {
        const provider = {
            ensureInitialized: vi.fn(),
            getMergedOptions: vi.fn(() => ({
                model: "models/gemini-2.5-flash-latest",
                modelParams: undefined,
                providerParams: undefined
            }))
        } as any;
        const client = {
            models: {
                generateContent: vi.fn().mockResolvedValue({
                    text: undefined,
                    responseId: undefined
                })
            }
        };

        const cap = new GeminiChatCapabilityImpl(provider, client as any);
        const res = await cap.chat({
            input: { messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }] }
        } as any);

        expect(client.models.generateContent.mock.calls[0][0].model).toBe("gemini-2.5-flash-latest");
        expect(res.output.content).toEqual([]);
        expect(res.id).toBeDefined();
    });

    it("chatStream emits batched chunks and a final completion chunk", async () => {
        const streamObj = {
            async *[Symbol.asyncIterator]() {
                yield { text: "ab", responseId: "s1", usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 } };
                yield { text: "cd", responseId: "s1", usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 2, totalTokenCount: 3 } };
                yield { text: "", responseId: "s1", usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 2, totalTokenCount: 3 } };
            }
        };

        const client = {
            models: {
                generateContentStream: vi.fn().mockResolvedValue(streamObj)
            }
        };

        const cap = new GeminiChatCapabilityImpl(makeProvider(), client as any);
        const chunks: any[] = [];
        for await (const chunk of cap.chatStream({
            input: { messages: [{ role: "user", content: [{ type: "text", text: "go" }] }] },
            context: { requestId: "r-stream" }
        } as any)) {
            chunks.push(chunk);
        }

        expect(chunks).toHaveLength(3);
        expect(chunks[0].metadata.status).toBe("incomplete");
        expect(chunks[0].delta.content[0]?.text).toBe("abcd");
        expect(chunks[1].metadata.status).toBe("incomplete");
        expect(chunks[1].output.content[0]?.text).toBe("abcd");
        expect(chunks[2].done).toBe(true);
        expect(chunks[2].metadata.status).toBe("completed");
    });

    it("chatStream yields error chunk when stream throws", async () => {
        const client = {
            models: {
                generateContentStream: vi.fn().mockRejectedValue(new Error("stream fail"))
            }
        };

        const cap = new GeminiChatCapabilityImpl(makeProvider(), client as any);
        const out = await cap.chatStream({
            input: { messages: [{ role: "user", content: [{ type: "text", text: "go" }] }] }
        } as any).next();

        expect(out.value?.done).toBe(true);
        expect(out.value?.metadata?.status).toBe("error");
    });

    it("chatStream exits silently when aborted", async () => {
        const streamObj = {
            async *[Symbol.asyncIterator]() {
                yield { text: "ab", responseId: "s1" };
            }
        };

        const client = {
            models: {
                generateContentStream: vi.fn().mockResolvedValue(streamObj)
            }
        };

        const cap = new GeminiChatCapabilityImpl(makeProvider(), client as any);
        const controller = new AbortController();
        controller.abort();

        const out = await cap.chatStream(
            {
                input: { messages: [{ role: "user", content: [{ type: "text", text: "go" }] }] }
            } as any,
            undefined,
            controller.signal
        ).next();

        expect(out.done).toBe(true);
        expect(out.value).toBeUndefined();
    });

    it("chatStream creates completion chunk even when stream deltas are empty", async () => {
        const provider = {
            ensureInitialized: vi.fn(),
            getMergedOptions: vi.fn(() => ({
                model: undefined,
                modelParams: undefined,
                providerParams: undefined,
                generalParams: {}
            }))
        } as any;
        const streamObj = {
            async *[Symbol.asyncIterator]() {
                yield { text: "", responseId: undefined };
            }
        };
        const client = {
            models: {
                generateContentStream: vi.fn().mockResolvedValue(streamObj)
            }
        };
        const cap = new GeminiChatCapabilityImpl(provider, client as any);

        const chunks: any[] = [];
        for await (const c of cap.chatStream({
            input: { messages: [{ role: "user", content: [{ type: "text", text: "go" }] }] }
        } as any)) {
            chunks.push(c);
        }

        expect(chunks).toHaveLength(1);
        expect(chunks[0].done).toBe(true);
        expect(chunks[0].metadata.status).toBe("completed");
    });

    it("buildContents maps supported parts and throws for unsupported type", () => {
        const cap = new GeminiChatCapabilityImpl(makeProvider(), { models: {} } as any) as any;
        const mapped = cap.buildContents([
            {
                role: "user",
                content: [
                    { type: "text", text: "x" },
                    { type: "image", url: "u", base64: "b", caption: "c" },
                    { type: "audio", url: "a", base64: "ab", mimeType: "audio/wav" },
                    { type: "video", url: "v", base64: "vb", mimeType: "video/mp4" },
                    { type: "file", url: "f", base64: "fb", filename: "n", mimeType: "text/plain" }
                ]
            }
        ]);

        expect(mapped).toHaveLength(5);
        expect(() =>
            cap.buildContents([{ role: "user", content: [{ type: "unknown", value: 1 }] }])
        ).toThrow("Unsupported Gemini chat part");
    });
});
