import { describe, expect, it, vi } from "vitest";
import { AnthropicModerationCapabilityImpl } from "#root/providers/anthropic/capabilities/AnthropicModerationCapabilityImpl.js";
import { MultiModalExecutionContext } from "#root/index.js";

function makeProvider() {
    return {
        ensureInitialized: vi.fn(),
        getMergedOptions: vi.fn(() => ({ model: "claude-mod", modelParams: {}, providerParams: {} }))
    } as any;
}

describe("AnthropicModerationCapabilityImpl", () => {
    it("validates input and aborts when signal is aborted", async () => {
        const cap = new AnthropicModerationCapabilityImpl(makeProvider(), { messages: {} } as any);

        await expect(cap.moderation({ input: {} } as any, new MultiModalExecutionContext())).rejects.toThrow(
            "Invalid moderation input"
        );
        await expect(cap.moderation({ input: { input: [] } } as any, new MultiModalExecutionContext())).rejects.toThrow(
            "Invalid moderation input"
        );

        const controller = new AbortController();
        controller.abort();
        await expect(
            cap.moderation({ input: { input: "x" } } as any, new MultiModalExecutionContext(), controller.signal)
        ).rejects.toThrow("Request aborted");
    });

    it("parses moderation JSON (including fenced JSON) and returns normalized output", async () => {
        const response1 = {
            content: [
                {
                    type: "text",
                    text: '{"flagged":false,"categories":{"hate":false,"violence":false,"sexual":false,"harassment":false,"illegal":false,"spam":false},"severity":"none","explanation":"safe"}'
                }
            ],
            usage: { input_tokens: 2, output_tokens: 3 }
        };

        const response2 = {
            content: [
                {
                    type: "text",
                    text: `\`\`\`json
{"flagged":true,"categories":{"hate":true,"violence":false,"sexual":false,"harassment":false,"illegal":false,"spam":true},"severity":"high","explanation":"harmful"}
\`\`\``
                }
            ],
            usage: { input_tokens: 1, output_tokens: 4 }
        };

        const client = {
            messages: {
                create: vi.fn().mockResolvedValueOnce(response1).mockResolvedValueOnce(response2)
            }
        };

        const cap = new AnthropicModerationCapabilityImpl(makeProvider(), client as any);
        const res = await cap.moderation(
            { input: { input: ["a", "b"] }, context: { requestId: "rid", metadata: { trace: "t" } } } as any,
            new MultiModalExecutionContext()
        );

        expect(res.output).toHaveLength(2);
        expect(res.output[0].flagged).toBe(false);
        expect(res.output[1].flagged).toBe(true);
        expect(res.output[1].categoryScores?.hate).toBe(1);
        expect(res.output[1].categoryScores?.violence).toBe(0);
        expect(res.output[1].reason).toBe("harmful");
        expect(res.metadata?.tokensUsed).toBe(10);
        expect(res.metadata?.requestId).toBe("rid");
    });

    it("throws when model returns no text block", async () => {
        const client = {
            messages: {
                create: vi.fn().mockResolvedValue({ content: [{ type: "tool_use" }], usage: {} })
            }
        };

        const cap = new AnthropicModerationCapabilityImpl(makeProvider(), client as any);
        await expect(
            cap.moderation({ input: { input: "x" } } as any, new MultiModalExecutionContext())
        ).rejects.toThrow("Anthropic moderation returned no text");
    });

    it("uses defaults for model/options and handles missing usage/explanation", async () => {
        const provider = {
            ensureInitialized: vi.fn(),
            getMergedOptions: vi.fn(() => ({ model: undefined, modelParams: undefined, providerParams: undefined }))
        } as any;
        const client = {
            messages: {
                create: vi.fn().mockResolvedValue({
                    content: [
                        {
                            type: "text",
                            text: '{"flagged":false,"categories":{"hate":false,"violence":false,"sexual":false,"harassment":false,"illegal":false,"spam":false},"severity":"none","explanation":""}'
                        }
                    ]
                })
            }
        };

        const cap = new AnthropicModerationCapabilityImpl(provider, client as any);
        const res = await cap.moderation({ input: { input: "single" } } as any, new MultiModalExecutionContext());
        const call = client.messages.create.mock.calls[0][0];

        expect(call.model).toBe("claude-sonnet-4-20250514");
        expect(res.output).toHaveLength(1);
        expect(res.output[0].reason).toBeUndefined();
        expect(res.metadata?.tokensUsed).toBe(0);
    });
});
