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
    it("throws when aborted before API call", async () => {
        const provider = makeProvider();
        const cap = new GeminiVideoAnalysisCapabilityImpl(provider, { models: { generateContent: vi.fn() } } as any);
        const ac = new AbortController();
        ac.abort();
        await expect(
            cap.analyzeVideo({ input: { videos: [{ id: "v1", url: "https://example.com/v.mp4" }] } } as any, undefined, ac.signal)
        ).rejects.toThrow("Video analysis aborted before API call");
    });

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

    it("uses URL fileData path and custom default prompt from config", async () => {
        const provider = makeProvider();
        provider.getMergedOptions = vi.fn((_capability: string, runtimeOptions: any) => ({
            model: runtimeOptions?.model,
            modelParams: {},
            providerParams: {},
            generalParams: {
                defaultPrompt: "Use this default prompt",
                defaultVideoMimeType: "video/quicktime"
            }
        }));
        const generateContent = vi.fn().mockResolvedValue({ text: "Narrative summary" });
        const cap = new GeminiVideoAnalysisCapabilityImpl(provider, { models: { generateContent } } as any);

        const out = await cap.analyzeVideo({
            input: {
                videos: [{ id: "v-url", url: "https://example.com/video.mov" }],
                params: { outputFormat: "text" }
            }
        } as any);

        const callArg = generateContent.mock.calls[0][0];
        expect(callArg.contents[0].parts[0].text).toContain("Use this default prompt");
        expect(callArg.contents[0].parts[1].fileData.mimeType).toBe("video/quicktime");
        expect(out.output[0]?.summary).toBe("Narrative summary");
    });

    it("helper methods cover build/normalize edge branches", () => {
        const cap = new GeminiVideoAnalysisCapabilityImpl(makeProvider(), { models: {} } as any);

        expect(() =>
            (cap as any).buildContents(
                { id: "broken", mimeType: "video/mp4" },
                undefined,
                "json",
                "default prompt",
                "video/mp4"
            )
        ).toThrow("Each video must include either base64 or url");

        const normalized = (cap as any).normalizeVideoAnalysis("src-1", "fallback text", [
            {
                summary: "Structured summary",
                tags: ["one", "", "two"],
                moments: [{ timestampSeconds: 1.5, text: "hit" }, { timestampSeconds: 2.1, text: "" }]
            }
        ]);
        expect(normalized.summary).toBe("Structured summary");
        expect(normalized.tags).toEqual(["one", "two"]);
        expect(normalized.moments).toEqual([{ timestampSeconds: 1.5, text: "hit" }]);

        const fallback = (cap as any).normalizeVideoAnalysis(undefined, "   fallback only  ");
        expect(fallback.summary).toBe("   fallback only  ");
    });
});
