import { describe, expect, it, vi } from "vitest";
import { OpenAIEmbedCapabilityImpl } from "#root/providers/openai/capabilities/OpenAIEmbedCapabilityImpl.js";

function makeProvider() {
    return {
        ensureInitialized: vi.fn(),
        getMergedOptions: vi.fn(() => ({ model: "text-embedding-3-large", modelParams: {}, providerParams: {} }))
    } as any;
}

describe("OpenAIEmbedCapabilityImpl", () => {
    it("validates missing input", async () => {
        const cap = new OpenAIEmbedCapabilityImpl(makeProvider(), { embeddings: {} } as any);
        await expect(cap.embed({ input: {} } as any)).rejects.toThrow("Invalid embedding input");
    });

    it("throws when API returns no data", async () => {
        const client = {
            embeddings: {
                create: vi.fn().mockResolvedValue({ data: [] })
            }
        };
        const cap = new OpenAIEmbedCapabilityImpl(makeProvider(), client as any);

        await expect(cap.embed({ input: { input: "x" } } as any)).rejects.toThrow("OpenAI returned no embeddings");
    });

    it("normalizes embedding vectors and metadata", async () => {
        const client = {
            embeddings: {
                create: vi.fn().mockResolvedValue({
                    data: [{ embedding: [0.1, 0.2] }, { embedding: [0.3] }],
                    usage: { total_tokens: 9 }
                })
            }
        };
        const cap = new OpenAIEmbedCapabilityImpl(makeProvider(), client as any);

        const res = await cap.embed({ input: { input: ["a", "b"] }, context: { requestId: "r1" } } as any);

        expect(res.output).toHaveLength(2);
        expect(res.output[0].vector).toEqual([0.1, 0.2]);
        expect(res.output[0].dimensions).toBe(2);
        expect(res.output[1].vector).toEqual([0.3]);
        expect(res.metadata?.tokensUsed).toBe(9);
        expect(res.output[1].metadata?.requestId).toBe("r1");
    });

    it("handles single-input defaults, custom purpose, and missing usage", async () => {
        const provider = {
            ensureInitialized: vi.fn(),
            getMergedOptions: vi.fn(() => ({ model: undefined, modelParams: undefined, providerParams: undefined }))
        } as any;
        const client = {
            embeddings: {
                create: vi.fn().mockResolvedValue({
                    data: [{ embedding: [1, 2, 3] }]
                })
            }
        };
        const cap = new OpenAIEmbedCapabilityImpl(provider, client as any);

        const req = {
            input: { input: "hello", inputId: "in-1" },
            purpose: "retrieval"
        } as any;

        const res = await cap.embed(req);
        const call = client.embeddings.create.mock.calls[0][0];

        expect(call.model).toBe("text-embedding-3-large");
        expect(res.output[0].inputId).toBe("in-1");
        expect(res.output[0].purpose).toBe("retrieval");
        expect(res.metadata?.tokensUsed).toBeUndefined();
    });
});
