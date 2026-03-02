import { describe, expect, it, vi } from "vitest";
import { GeminiVideoGenerationCapabilityImpl } from "#root/providers/gemini/capabilities/GeminiVideoGenerationCapabilityImpl.js";
import { writeFile } from "node:fs/promises";

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

describe("GeminiVideoGenerationCapabilityImpl", () => {
    it("validates prompt", async () => {
        const provider = makeProvider();
        const cap = new GeminiVideoGenerationCapabilityImpl(provider, { models: {}, operations: {} } as any);
        await expect(cap.generateVideo({ input: {} } as any)).rejects.toThrow("Prompt is required");
    });

    it("generates video without polling when disabled", async () => {
        const provider = makeProvider();
        const generateVideos = vi.fn().mockResolvedValue({
            done: true,
            name: "operations/gv1",
            response: {
                generatedVideos: [{ video: { uri: "https://example.com/v.mp4", mimeType: "video/mp4" } }]
            }
        });
        const client = { models: { generateVideos }, operations: { getVideosOperation: vi.fn() } };
        const cap = new GeminiVideoGenerationCapabilityImpl(provider, client as any);

        const out = await cap.generateVideo({
            input: { prompt: "A sunrise", params: { pollUntilComplete: false } }
        } as any);

        expect(generateVideos).toHaveBeenCalledTimes(1);
        expect(out.output[0]?.url).toBe("https://example.com/v.mp4");
        expect(out.output[0]?.mimeType).toBe("video/mp4");
    });

    it("polls until done and can include inline base64", async () => {
        const provider = makeProvider();
        const generateVideos = vi.fn().mockResolvedValue({
            done: false,
            name: "operations/gv2"
        });
        const getVideosOperation = vi.fn().mockResolvedValue({
            done: true,
            name: "operations/gv2",
            response: {
                generatedVideos: [{ video: { videoBytes: "AQID", mimeType: "video/mp4" } }]
            }
        });
        const client = { models: { generateVideos }, operations: { getVideosOperation } };
        const cap = new GeminiVideoGenerationCapabilityImpl(provider, client as any);
        vi.spyOn(cap as any, "delay").mockResolvedValue(undefined);

        const out = await cap.generateVideo({
            input: { prompt: "A sunset", params: { includeBase64: true } }
        } as any);

        expect(getVideosOperation).toHaveBeenCalledTimes(1);
        expect(out.output[0]?.base64).toBe("AQID");
    });

    it("falls back to files.download when protected URI returns 403", async () => {
        const provider = makeProvider();
        const generateVideos = vi.fn().mockResolvedValue({
            done: true,
            name: "operations/gv3",
            response: {
                generatedVideos: [{ video: { uri: "https://example.com/files/abc123:download", mimeType: "video/mp4" } }]
            }
        });
        const download = vi.fn(async ({ downloadPath }: { downloadPath: string }) => {
            await writeFile(downloadPath, Buffer.from([1, 2, 3]));
        });
        const client = { models: { generateVideos }, operations: { getVideosOperation: vi.fn() }, files: { download } };
        const cap = new GeminiVideoGenerationCapabilityImpl(provider, client as any);

        vi.stubGlobal(
            "fetch",
            vi.fn().mockResolvedValue({ ok: false, status: 403, statusText: "Forbidden" } as Partial<Response>)
        );
        try {
            const out = await cap.generateVideo({
                input: { prompt: "A city", params: { includeBase64: true, pollUntilComplete: false } }
            } as any);
            expect(download).toHaveBeenCalledTimes(1);
            expect(out.output[0]?.base64).toBe("AQID");
        } finally {
            vi.unstubAllGlobals();
        }
    });
});
