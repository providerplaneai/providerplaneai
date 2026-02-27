import { describe, expect, it, vi } from "vitest";
import { OpenAIChatCapabilityImpl } from "#root/providers/openai/capabilities/OpenAIChatCapabilityImpl.js";

function makeProvider() {
    return {
        ensureInitialized: vi.fn(),
        getMergedOptions: vi.fn(() => ({
            model: "gpt-4.1",
            modelParams: {},
            providerParams: {},
            generalParams: { chatStreamBatchSize: 3 }
        }))
    } as any;
}

describe("OpenAIChatCapabilityImpl", () => {
    it("throws for missing input messages and aborted request", async () => {
        const cap = new OpenAIChatCapabilityImpl(makeProvider(), { responses: {} } as any);

        await expect(cap.chat({ input: {} } as any)).rejects.toThrow("Received empty input messages");
        await expect(cap.chatStream({ input: {} } as any).next()).rejects.toThrow("Received empty input messages");

        const controller = new AbortController();
        controller.abort();
        await expect(
            cap.chat({ input: { messages: [{ role: "user", content: [{ type: "text", text: "x" }] }] } } as any, undefined, controller.signal)
        ).rejects.toThrow("Request aborted");
    });

    it("chat normalizes assistant text from response output", async () => {
        const client = {
            responses: {
                create: vi.fn().mockResolvedValue({
                    id: "r1",
                    status: "completed",
                    usage: { total_tokens: 5, input_tokens: 2, output_tokens: 3 },
                    output: [
                        { type: "message", role: "assistant", content: [{ type: "output_text", text: "hello" }] },
                        { type: "message", role: "assistant", content: [{ type: "output_text", text: " world" }] },
                        { type: "message", role: "user", content: [{ type: "output_text", text: "ignored" }] }
                    ]
                })
            }
        };

        const cap = new OpenAIChatCapabilityImpl(makeProvider(), client as any);
        const res = await cap.chat({
            input: { messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] },
            context: { requestId: "rid" }
        } as any);

        expect(res.id).toBe("r1");
        expect(res.output.role).toBe("assistant");
        expect(res.output.content[0]).toMatchObject({ type: "text", text: "hello world" });
        expect(res.metadata?.provider).toBe("openai");
        expect(res.metadata?.requestId).toBe("rid");
    });

    it("chat handles empty output payloads", async () => {
        const client = {
            responses: {
                create: vi.fn().mockResolvedValue({
                    id: "r-empty",
                    status: "completed"
                })
            }
        };

        const cap = new OpenAIChatCapabilityImpl(makeProvider(), client as any);
        const res = await cap.chat({
            input: { messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] }
        } as any);

        expect(res.output.content).toEqual([]);
    });

    it("chatStream emits batched, flush, and final chunks", async () => {
        const streamObj = {
            async *[Symbol.asyncIterator]() {
                yield { type: "response.created", response: { id: "sid" } };
                yield { type: "response.output_text.delta", delta: "ab" };
                yield { type: "response.output_text.delta", delta: "cd" };
                yield { type: "response.output_text.done" };
            }
        };
        const client = { responses: { stream: vi.fn().mockResolvedValue(streamObj) } };

        const cap = new OpenAIChatCapabilityImpl(makeProvider(), client as any);
        const chunks: any[] = [];
        for await (const c of cap.chatStream({
            input: { messages: [{ role: "user", content: [{ type: "text", text: "go" }] }] },
            context: { requestId: "rq" }
        } as any)) {
            chunks.push(c);
        }

        expect(chunks).toHaveLength(3);
        expect(chunks[0].metadata.status).toBe("incomplete");
        expect(chunks[0].delta.content[0]?.text).toBe("abcd");
        expect(chunks[1].metadata.status).toBe("incomplete");
        expect(chunks[1].output.content[0]?.text).toBe("abcd");
        expect(chunks[2].done).toBe(true);
        expect(chunks[2].metadata.status).toBe("completed");
    });

    it("chatStream yields error chunk for Stream aborted", async () => {
        const client = {
            responses: {
                stream: vi.fn().mockRejectedValue(new Error("Stream aborted"))
            }
        };
        const cap = new OpenAIChatCapabilityImpl(makeProvider(), client as any);

        const out = await cap.chatStream({
            input: { messages: [{ role: "user", content: [{ type: "text", text: "go" }] }] }
        } as any).next();

        expect(out.value?.done).toBe(true);
        expect(out.value?.metadata?.status).toBe("error");
    });

    it("chatStream exits silently when signal is already aborted", async () => {
        const client = { responses: { stream: vi.fn() } };
        const cap = new OpenAIChatCapabilityImpl(makeProvider(), client as any);
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
        expect(client.responses.stream).not.toHaveBeenCalled();
    });

    it("chatStream ignores non-delta events and empty deltas", async () => {
        const streamObj = {
            async *[Symbol.asyncIterator]() {
                yield { type: "response.created", response: { id: "sid-2" } };
                yield { type: "response.some_other_event" };
                yield { type: "response.output_text.delta" };
                yield { type: "response.output_text.done" };
            }
        };
        const client = { responses: { stream: vi.fn().mockResolvedValue(streamObj) } };
        const cap = new OpenAIChatCapabilityImpl(makeProvider(), client as any);

        const chunks: any[] = [];
        for await (const c of cap.chatStream({
            input: { messages: [{ role: "user", content: [{ type: "text", text: "go" }] }] }
        } as any)) {
            chunks.push(c);
        }

        expect(chunks).toHaveLength(1);
        expect(chunks[0].done).toBe(true);
    });

    it("mapParts enforces media requirements and supports all part types", async () => {
        const cap = new OpenAIChatCapabilityImpl(makeProvider(), { responses: {} } as any) as any;

        expect(() => cap.mapParts([{ type: "image" }])).toThrow("must have url or base64");
        expect(() => cap.mapParts([{ type: "unknown", url: "x" }])).toThrow("Unsupported message part");

        const parts = cap.mapParts([
            { type: "text", text: "t" },
            { type: "image", base64: "QQ==", mimeType: "image/png" },
            { type: "audio", base64: "QQ==", mimeType: "audio/wav" },
            { type: "video", base64: "QQ==", mimeType: "video/mp4" },
            { type: "file", base64: "QQ==", mimeType: "text/plain", filename: "a.txt" }
        ]);

        expect(parts).toHaveLength(5);
        expect(parts[0].type).toBe("input_text");
        expect(parts[1].type).toBe("input_image");
        expect(parts[4].type).toBe("input_file");
    });
});
