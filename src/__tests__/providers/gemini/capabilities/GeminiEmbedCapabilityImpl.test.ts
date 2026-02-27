import { describe, expect, it, vi } from "vitest";
import { GeminiEmbedCapabilityImpl } from "#root/providers/gemini/capabilities/GeminiEmbedCapabilityImpl.js";

function makeProvider() {
    return {
        ensureInitialized: vi.fn(),
        getMergedOptions: vi.fn(() => ({ model: "text-embedding-004", modelParams: {}, providerParams: {} }))
    } as any;
}

describe("GeminiEmbedCapabilityImpl", () => {
    it("validates missing input and aborted signal", async () => {
        const cap = new GeminiEmbedCapabilityImpl(makeProvider(), { models: {} } as any);

        await expect(cap.embed({ input: {} } as any)).rejects.toThrow("Invalid embedding input");

        const controller = new AbortController();
        controller.abort();
        await expect(cap.embed({ input: { input: "x" } } as any, undefined, controller.signal)).rejects.toThrow("Request aborted");
    });

    it("throws when API returns no embeddings or mismatched count", async () => {
        const client = {
            models: {
                embedContent: vi
                    .fn()
                    .mockResolvedValueOnce({ embeddings: [] })
                    .mockResolvedValueOnce({ embeddings: [{ values: [1] }, { values: [2] }] })
            }
        };
        const cap = new GeminiEmbedCapabilityImpl(makeProvider(), client as any);

        await expect(cap.embed({ input: { input: "x" } } as any)).rejects.toThrow("API returned no embeddings");
        await expect(cap.embed({ input: { input: "x" } } as any)).rejects.toThrow("returned 2 embeddings for 1 inputs");
    });

    it("throws when embedding values are missing", async () => {
        const client = {
            models: {
                embedContent: vi.fn().mockResolvedValue({ embeddings: [{ values: undefined }] })
            }
        };
        const cap = new GeminiEmbedCapabilityImpl(makeProvider(), client as any);

        await expect(cap.embed({ input: { input: "x" } } as any)).rejects.toThrow("missing values");
    });

    it("normalizes embeddings and metadata for single and multiple inputs", async () => {
        const client = {
            models: {
                embedContent: vi.fn().mockResolvedValue({
                    embeddings: [{ values: [0.1, 0.2] }, { values: [0.3] }],
                    usageMetadata: { totalTokenCount: 9 }
                })
            }
        };
        const cap = new GeminiEmbedCapabilityImpl(makeProvider(), client as any);

        const res = await cap.embed({ input: { input: ["a", "b"] }, context: { requestId: "r1" } } as any);

        expect(res.output).toHaveLength(2);
        expect(res.output[0].vector).toEqual([0.1, 0.2]);
        expect(res.output[0].dimensions).toBe(2);
        expect(res.metadata?.provider).toBe("gemini");
        expect(res.metadata?.tokensUsed).toBe(9);
        expect(res.output[1].metadata?.requestId).toBe("r1");
    });
});
