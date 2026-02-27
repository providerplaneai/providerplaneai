import { describe, expect, it, vi } from "vitest";
import { GeminiModerationCapabilityImpl } from "#root/providers/gemini/capabilities/GeminiModerationCapabilityImpl.js";

function makeProvider() {
    return {
        ensureInitialized: vi.fn(),
        getMergedOptions: vi.fn(() => ({ model: "gemini-2.5-flash-lite", modelParams: {}, providerParams: {} }))
    } as any;
}

describe("GeminiModerationCapabilityImpl", () => {
    it("validates missing moderation input and aborted signal", async () => {
        const cap = new GeminiModerationCapabilityImpl(makeProvider(), { models: {} } as any);

        await expect(cap.moderation({ input: {} } as any)).rejects.toThrow("Invalid moderation input");

        const controller = new AbortController();
        controller.abort();
        await expect(cap.moderation({ input: { input: "x" } } as any, undefined, controller.signal)).rejects.toThrow("Request aborted");
    });

    it("normalizes moderation outputs for single and array input", async () => {
        const client = {
            models: {
                generateContent: vi
                    .fn()
                    .mockResolvedValueOnce({ text: '{"flagged":false,"categories":{"sexual":false,"hate":false,"harassment":false,"self_harm":false,"violence":false},"reasoning":"safe"}' })
                    .mockResolvedValueOnce({ text: '{"flagged":true,"categories":{"sexual":true,"hate":false,"harassment":false,"self_harm":false,"violence":false},"reasoning":"explicit"}' })
            }
        };

        const cap = new GeminiModerationCapabilityImpl(makeProvider(), client as any);
        const res = await cap.moderation({ input: { input: ["a", "b"] }, context: { requestId: "r1" } } as any);

        expect(res.output).toHaveLength(2);
        expect(res.output[0].flagged).toBe(false);
        expect(res.output[1].flagged).toBe(true);
        expect(res.output[1].categories.sexual).toBe(true);
        expect(res.output[1].reason).toBe("explicit");
        expect(res.metadata?.provider).toBe("gemini");
        expect(res.metadata?.requestId).toBe("r1");
    });

    it("handles malformed JSON by surfacing parse failure", async () => {
        const client = {
            models: {
                generateContent: vi.fn().mockResolvedValue({ text: "not-json" })
            }
        };

        const cap = new GeminiModerationCapabilityImpl(makeProvider(), client as any);
        await expect(cap.moderation({ input: { input: "x" } } as any)).rejects.toThrow();
    });

    it("uses default model/options path and normalizes missing optional fields", async () => {
        const provider = {
            ensureInitialized: vi.fn(),
            getMergedOptions: vi.fn(() => ({ model: undefined, modelParams: undefined, providerParams: undefined }))
        } as any;
        const client = {
            models: {
                generateContent: vi.fn().mockResolvedValue({ text: '{"flagged":false}' })
            }
        };

        const cap = new GeminiModerationCapabilityImpl(provider, client as any);
        const res = await cap.moderation({ input: { input: "single" } } as any);

        expect(client.models.generateContent).toHaveBeenCalledOnce();
        const call = client.models.generateContent.mock.calls[0][0];
        expect(call.model).toBe("gemini-2.5-flash-lite");
        expect(res.output).toHaveLength(1);
        expect(res.output[0].flagged).toBe(false);
        expect(res.output[0].reason).toBeUndefined();
        expect(res.output[0].categories).toEqual({});
    });
});
