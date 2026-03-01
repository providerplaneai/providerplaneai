import { describe, expect, it, vi } from "vitest";
import { AnthropicChatCapabilityImpl } from "#root/providers/anthropic/capabilities/AnthropicChatCapabilityImpl.js";

function makeProvider() {
    return {
        ensureInitialized: vi.fn(),
        getMergedOptions: vi.fn(() => ({
            model: "claude-test",
            modelParams: {},
            providerParams: {},
            generalParams: { chatStreamBatchSize: 3 }
        }))
    } as any;
}

describe("AnthropicChatCapabilityImpl", () => {
    it("throws for missing input messages in chat and stream", async () => {
        const provider = makeProvider();
        const cap = new AnthropicChatCapabilityImpl(provider, { messages: {} } as any);

        await expect(cap.chat({ input: {} } as any)).rejects.toThrow("Received empty input messages");
        await expect(cap.chatStream({ input: {} } as any).next()).rejects.toThrow("Received empty input messages");
        expect(provider.ensureInitialized).toHaveBeenCalledTimes(2);
    });

    it("chat returns normalized assistant message and usage metadata", async () => {
        const provider = makeProvider();
        const client = {
            messages: {
                create: vi.fn().mockResolvedValue({
                    id: "msg-1",
                    stop_reason: "max_tokens",
                    content: [
                        { type: "text", text: "hello " },
                        { type: "text", text: "world" },
                        { type: "tool_use" }
                    ],
                    usage: { input_tokens: 2, output_tokens: 3 }
                })
            }
        };

        const cap = new AnthropicChatCapabilityImpl(provider, client as any);
        const res = await cap.chat({
            input: { messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] },
            context: { requestId: "r1", metadata: { trace: "t1" } }
        } as any);

        expect(res.output.id).toBe("msg-1");
        expect(res.output.role).toBe("assistant");
        expect(res.output.content[0]).toMatchObject({ type: "text", text: "hello world" });
        expect(res.output.metadata?.status).toBe("incomplete");
        expect(res.metadata?.provider).toBe("anthropic");
        expect(res.metadata?.requestId).toBe("r1");
        expect(res.metadata?.inputTokens).toBe(2);
        expect(res.metadata?.outputTokens).toBe(3);
        expect(res.metadata?.totalTokens).toBe(5);
    });

    it("chat rejects unsupported non-text message parts", async () => {
        const provider = makeProvider();
        const client = { messages: { create: vi.fn() } };
        const cap = new AnthropicChatCapabilityImpl(provider, client as any);

        await expect(
            cap.chat({
                input: { messages: [{ role: "user", content: [{ type: "image", url: "x" }] }] }
            } as any)
        ).rejects.toThrow("Anthropic chat only supports text parts");
    });

    it("chat rejects pre-aborted requests and maps completed stop reasons", async () => {
        const provider = makeProvider();
        const client = {
            messages: {
                create: vi.fn().mockResolvedValue({
                    id: "msg-2",
                    stop_reason: "end_turn",
                    content: [{ type: "text", text: "ok" }]
                })
            }
        };
        const cap = new AnthropicChatCapabilityImpl(provider, client as any);
        const controller = new AbortController();
        controller.abort();

        await expect(
            cap.chat({ input: { messages: [{ role: "user", content: [{ type: "text", text: "x" }] }] } } as any, undefined, controller.signal)
        ).rejects.toThrow("Request aborted");

        const res = await cap.chat({
            input: { messages: [{ role: "user", content: [{ type: "text", text: "x" }] }] }
        } as any);
        expect(res.metadata?.status).toBe("completed");
    });

    it("chatStream emits batched deltas and a final completed chunk", async () => {
        const provider = makeProvider();
        const streamObj = {
            async *[Symbol.asyncIterator]() {
                yield { type: "message_start", message: { id: "m-stream" } };
                yield { type: "content_block_delta", delta: { type: "text_delta", text: "ab" } };
                yield { type: "content_block_delta", delta: { type: "text_delta", text: "cd" } };
            },
            finalMessage: vi.fn().mockResolvedValue({ usage: { input_tokens: 1, output_tokens: 4 } })
        };

        const client = { messages: { stream: vi.fn().mockReturnValue(streamObj) } };
        const cap = new AnthropicChatCapabilityImpl(provider, client as any);

        const chunks: any[] = [];
        for await (const c of cap.chatStream({
            input: { messages: [{ role: "user", content: [{ type: "text", text: "go" }] }] },
            context: { requestId: "rid" }
        } as any)) {
            chunks.push(c);
        }

        expect(chunks.length).toBe(2);
        expect(chunks[0].delta.content[0]?.text).toBe("abcd");
        expect(chunks[0].metadata.status).toBe("incomplete");
        expect(chunks[1].done).toBe(true);
        expect(chunks[1].metadata.status).toBe("completed");
        expect(chunks[1].output.metadata?.totalTokens).toBe(5);
    });

    it("chatStream yields an error chunk when stream throws Stream aborted", async () => {
        const provider = makeProvider();
        const client = {
            messages: {
                stream: vi.fn(() => {
                    throw new Error("Stream aborted");
                })
            }
        };
        const cap = new AnthropicChatCapabilityImpl(provider, client as any);

        const out = await cap.chatStream({
            input: { messages: [{ role: "user", content: [{ type: "text", text: "go" }] }] }
        } as any).next();

        expect(out.value?.done).toBe(true);
        expect(out.value?.metadata?.status).toBe("error");
    });

    it("chatStream suppresses non-abort stream errors (no terminal error chunk)", async () => {
        const provider = makeProvider();
        const client = {
            messages: {
                stream: vi.fn(() => {
                    throw new Error("transport failed");
                })
            }
        };
        const cap = new AnthropicChatCapabilityImpl(provider, client as any);

        const out = await cap.chatStream({
            input: { messages: [{ role: "user", content: [{ type: "text", text: "go" }] }] }
        } as any).next();

        expect(out.done).toBe(true);
        expect(out.value).toBeUndefined();
    });

    it("chatStream flushes short buffer and exits silently when aborted", async () => {
        const provider = makeProvider();
        const streamObj = {
            async *[Symbol.asyncIterator]() {
                yield { type: "message_start", message: { id: "m-stream-2" } };
                yield { type: "content_block_delta", delta: { type: "text_delta", text: "a" } };
            },
            finalMessage: vi.fn().mockRejectedValue(new Error("no final"))
        };
        const client = { messages: { stream: vi.fn().mockReturnValue(streamObj) } };
        const cap = new AnthropicChatCapabilityImpl(provider, client as any);

        const chunks: any[] = [];
        for await (const c of cap.chatStream({
            input: { messages: [{ role: "user", content: [{ type: "text", text: "go" }] }] }
        } as any)) {
            chunks.push(c);
        }
        expect(chunks[0].delta.content[0]?.text).toBe("a");
        expect(chunks[chunks.length - 1]?.done).toBe(true);

        const controller = new AbortController();
        controller.abort();
        const aborted = await cap.chatStream(
            { input: { messages: [{ role: "user", content: [{ type: "text", text: "go" }] }] } } as any,
            undefined,
            controller.signal
        ).next();
        expect(aborted.done).toBe(true);
        expect(aborted.value).toBeUndefined();
    });
});
