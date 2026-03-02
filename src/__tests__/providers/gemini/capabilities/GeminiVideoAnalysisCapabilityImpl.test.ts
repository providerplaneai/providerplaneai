import { describe, expect, it, vi } from "vitest";
import { GeminiVideoAnalysisCapabilityImpl } from "#root/providers/gemini/capabilities/GeminiVideoAnalysisCapabilityImpl.js";
import { MultiModalExecutionContext } from "#root/index.js";

function makeProvider() {
    return {
        ensureInitialized: vi.fn(),
        getMergedOptions: vi.fn((_capability: string, runtimeOptions: any) => ({
            model: runtimeOptions?.model,
            modelParams: {},
            providerParams: {},
            generalParams: runtimeOptions?.generalParams ?? {}
        }))
    } as any;
}

describe("GeminiVideoAnalysisCapabilityImpl", () => {
    it("requires at least one video from input or context", async () => {
        const provider = makeProvider();
        const cap = new GeminiVideoAnalysisCapabilityImpl(provider, { models: {} } as any);
        await expect(cap.analyzeVideo({ input: {} } as any)).rejects.toThrow("At least one video is required");
    });

    it("analyzes inline base64 video and parses json output", async () => {
        const provider = makeProvider();
        const generateContent = vi.fn().mockResolvedValue({
            text: JSON.stringify({
                summary: "A person walks across the street",
                tags: ["person", "street"],
                moments: [{ timestampSeconds: 1.2, text: "person enters frame" }]
            })
        });
        const cap = new GeminiVideoAnalysisCapabilityImpl(provider, { models: { generateContent } } as any);

        const out = await cap.analyzeVideo({
            input: {
                videos: [{ id: "vid-1", mimeType: "video/mp4", base64: "AQID" }],
                params: { outputFormat: "json" }
            }
        } as any);

        expect(generateContent).toHaveBeenCalledTimes(1);
        expect(out.output[0]?.id).toBe("vid-1");
        expect(out.output[0]?.summary).toContain("walks");
        expect(out.output[0]?.tags).toEqual(["person", "street"]);
    });

    it("falls back to latest context video when request videos are omitted", async () => {
        const provider = makeProvider();
        const generateContent = vi.fn().mockResolvedValue({ text: "Simple summary." });
        const cap = new GeminiVideoAnalysisCapabilityImpl(provider, { models: { generateContent } } as any);

        const ctx = new MultiModalExecutionContext();
        ctx.attachArtifacts({
            video: [{ id: "ctx-v1", mimeType: "video/mp4", base64: "AQID" }]
        });

        const out = await cap.analyzeVideo({ input: {} } as any, ctx);
        expect(out.output[0]?.sourceVideoId).toBe("ctx-v1");
        expect(out.output[0]?.summary).toBe("Simple summary.");
    });
});
