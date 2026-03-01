import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AnthropicEmbedCapabilityImpl } from "#root/providers/anthropic/capabilities/AnthropicEmbedCapabilityImpl.js";

const originalVoyage = process.env.VOYAGE_API_KEY;

function makeProvider() {
    return {
        ensureInitialized: vi.fn(),
        getMergedOptions: vi.fn(() => ({ model: "voyage-3", modelParams: {}, providerParams: {} }))
    } as any;
}

beforeEach(() => {
    vi.restoreAllMocks();
    process.env.VOYAGE_API_KEY = "voyage-test";
});

afterEach(() => {
    process.env.VOYAGE_API_KEY = originalVoyage;
    vi.resetAllMocks();
});

describe("AnthropicEmbedCapabilityImpl", () => {
    it("requires VOYAGE_API_KEY", () => {
        process.env.VOYAGE_API_KEY = "";
        expect(() => new AnthropicEmbedCapabilityImpl(makeProvider())).toThrow("Voyage AI API key is required");
    });

    it("validates missing input and aborted signal", async () => {
        const cap = new AnthropicEmbedCapabilityImpl(makeProvider());

        await expect(cap.embed({ input: {} } as any)).rejects.toThrow("Invalid embedding input");

        const controller = new AbortController();
        controller.abort();
        await expect(cap.embed({ input: { input: "x" } } as any, undefined, controller.signal)).rejects.toThrow("Request aborted");
    });

    it("throws on non-ok voyage response and empty data", async () => {
        const cap = new AnthropicEmbedCapabilityImpl(makeProvider());

        vi.stubGlobal(
            "fetch",
            vi.fn().mockResolvedValueOnce({ ok: false, status: 401, text: async () => "bad" })
        );
        await expect(cap.embed({ input: { input: "x" } } as any)).rejects.toThrow("Voyage AI API error: 401 - bad");

        vi.stubGlobal(
            "fetch",
            vi.fn().mockResolvedValueOnce({
                ok: true,
                json: async () => ({ data: [], usage: { total_tokens: 1 }, model: "voyage-3" })
            })
        );
        await expect(cap.embed({ input: { input: "x" } } as any)).rejects.toThrow("Voyage AI returned no embeddings");
    });

    it("normalizes embeddings for single and array input and preserves ordering", async () => {
        const cap = new AnthropicEmbedCapabilityImpl(makeProvider());
        const voyage = {
            object: "list",
            model: "voyage-3",
            usage: { total_tokens: 7 },
            data: [
                { object: "embedding", index: 1, embedding: [0.2, 0.3] },
                { object: "embedding", index: 0, embedding: [0.1] }
            ]
        };

        vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => voyage }));

        const single = await cap.embed({ input: { input: "hello" }, context: { requestId: "r1" } } as any);
        expect(single.output).toHaveLength(1);
        expect(single.output[0].vector).toEqual([0.1]);
        expect(single.output[0].inputId).toBeUndefined();
        expect(single.metadata?.embeddingProvider).toBe("voyage-ai");

        const multi = await cap.embed({ input: { input: ["a", "b"] }, context: { requestId: "r2" } } as any);
        expect(multi.output).toHaveLength(2);
        expect(multi.output[0].vector).toEqual([0.1]);
        expect(multi.output[1].vector).toEqual([0.2, 0.3]);
        expect(multi.output[0].metadata?.requestId).toBe("r2");
    });

    it("uses Voyage response model fallback and preserves single-input inputId", async () => {
        const provider = {
            ensureInitialized: vi.fn(),
            getMergedOptions: vi.fn(() => ({ model: undefined, modelParams: {}, providerParams: {} }))
        } as any;
        const cap = new AnthropicEmbedCapabilityImpl(provider);

        vi.stubGlobal(
            "fetch",
            vi.fn().mockResolvedValue({
                ok: true,
                json: async () => ({
                    object: "list",
                    model: "voyage-fallback-model",
                    usage: { total_tokens: 3 },
                    data: [{ object: "embedding", index: 0, embedding: [0.9, 0.1] }]
                })
            })
        );

        const res = await cap.embed({
            input: { input: "hello", inputId: "input-1" },
            context: { requestId: "r3" }
        } as any);

        expect(res.output).toHaveLength(1);
        expect(res.output[0].inputId).toBe("input-1");
        expect(res.output[0].metadata?.model).toBe("voyage-fallback-model");
        expect(res.metadata?.model).toBe("voyage-fallback-model");
    });
});
