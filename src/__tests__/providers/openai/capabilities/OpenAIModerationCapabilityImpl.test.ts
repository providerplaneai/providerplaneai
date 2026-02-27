import { describe, expect, it, vi } from "vitest";
import { OpenAIModerationCapabilityImpl } from "#root/providers/openai/capabilities/OpenAIModerationCapabilityImpl.js";

function makeProvider() {
    return {
        ensureInitialized: vi.fn(),
        getMergedOptions: vi.fn(() => ({ model: "omni-moderation-latest", modelParams: {}, providerParams: {} }))
    } as any;
}

describe("OpenAIModerationCapabilityImpl", () => {
    it("validates missing moderation input and aborted signal", async () => {
        const cap = new OpenAIModerationCapabilityImpl(makeProvider(), { moderations: {} } as any);

        await expect(cap.moderation({ input: {} } as any)).rejects.toThrow("Invalid moderation input");

        const controller = new AbortController();
        controller.abort();
        await expect(cap.moderation({ input: { input: "x" } } as any, undefined, controller.signal)).rejects.toThrow(
            "Request aborted"
        );
    });

    it("throws when API returns empty results", async () => {
        const client = { moderations: { create: vi.fn().mockResolvedValue({ results: [] }) } };
        const cap = new OpenAIModerationCapabilityImpl(makeProvider(), client as any);
        await expect(cap.moderation({ input: { input: "x" } } as any)).rejects.toThrow("OpenAI returned no moderation results");
    });

    it("normalizes moderation results with categories and reason", async () => {
        const client = {
            moderations: {
                create: vi.fn().mockResolvedValue({
                    results: [
                        {
                            flagged: true,
                            categories: { hate: true, violence: false },
                            category_scores: { hate: 0.9, violence: 0.1 }
                        },
                        {
                            flagged: false,
                            categories: { hate: false },
                            category_scores: {}
                        }
                    ]
                })
            }
        };

        const cap = new OpenAIModerationCapabilityImpl(makeProvider(), client as any);
        const res = await cap.moderation({ input: { input: ["a", "b"] }, context: { requestId: "rid" } } as any);

        expect(res.output).toHaveLength(2);
        expect(res.output[0].flagged).toBe(true);
        expect(res.output[0].reason).toContain("hate");
        expect(res.output[0].categoryScores?.hate).toBe(0.9);
        expect(res.output[1].categoryScores).toBeUndefined();
        expect(res.metadata?.provider).toBe("openai");
        expect(res.metadata?.requestId).toBe("rid");
    });

    it("uses default model path for single input and handles missing category maps", async () => {
        const provider = {
            ensureInitialized: vi.fn(),
            getMergedOptions: vi.fn(() => ({ model: undefined, modelParams: undefined, providerParams: undefined }))
        } as any;
        const client = {
            moderations: {
                create: vi.fn().mockResolvedValue({
                    results: [{ flagged: false }]
                })
            }
        };

        const cap = new OpenAIModerationCapabilityImpl(provider, client as any);
        const res = await cap.moderation({ input: { input: "one" } } as any);
        const call = client.moderations.create.mock.calls[0][0];

        expect(call.model).toBe("omni-moderation-latest");
        expect(Array.isArray(call.input)).toBe(true);
        expect(res.output[0].categories).toEqual({});
        expect(res.output[0].categoryScores).toBeUndefined();
        expect(res.output[0].reason).toBeUndefined();
    });
});
