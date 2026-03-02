import { describe, expect, it, vi } from "vitest";
import { GeminiVideoExtendCapabilityImpl } from "#root/providers/gemini/capabilities/GeminiVideoExtendCapabilityImpl.js";
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

describe("GeminiVideoExtendCapabilityImpl", () => {
    it("validates source video input", async () => {
        const provider = makeProvider();
        const cap = new GeminiVideoExtendCapabilityImpl(provider, { models: {}, operations: {} } as any);
        await expect(cap.extendVideo({ input: {} } as any)).rejects.toThrow("sourceVideoUri or sourceVideoBase64 is required");
    });

    it("extends video without polling when disabled", async () => {
        const provider = makeProvider();
        const generateVideos = vi.fn().mockResolvedValue({
            done: true,
            name: "operations/ge1",
            response: {
                generatedVideos: [{ video: { uri: "https://example.com/extended.mp4", mimeType: "video/mp4" } }]
            }
        });
        const client = { models: { generateVideos }, operations: { getVideosOperation: vi.fn() } };
        const cap = new GeminiVideoExtendCapabilityImpl(provider, client as any);

        const out = await cap.extendVideo({
            input: {
                sourceVideoUri: "gs://bucket/input.mp4",
                prompt: "continue motion",
                params: { pollUntilComplete: false }
            }
        } as any);

        expect(generateVideos).toHaveBeenCalledTimes(1);
        expect(out.output[0]?.url).toBe("https://example.com/extended.mp4");
    });

    it("falls back to files.download when includeBase64 is enabled and URI fetch is forbidden", async () => {
        const provider = makeProvider();
        const generateVideos = vi.fn().mockResolvedValue({
            done: true,
            name: "operations/ge2",
            response: {
                generatedVideos: [{ video: { uri: "https://example.com/files/abc123:download", mimeType: "video/mp4" } }]
            }
        });
        const download = vi.fn(async ({ downloadPath }: { downloadPath: string }) => {
            await writeFile(downloadPath, Buffer.from([1, 2, 3]));
        });
        const client = { models: { generateVideos }, operations: { getVideosOperation: vi.fn() }, files: { download } };
        const cap = new GeminiVideoExtendCapabilityImpl(provider, client as any);

        vi.stubGlobal(
            "fetch",
            vi.fn().mockResolvedValue({ ok: false, status: 403, statusText: "Forbidden" } as Partial<Response>)
        );
        try {
            const out = await cap.extendVideo({
                input: {
                    sourceVideoUri: "gs://bucket/input.mp4",
                    params: { pollUntilComplete: false, includeBase64: true, durationSeconds: 5 }
                }
            } as any);

            expect(download).toHaveBeenCalledTimes(1);
            expect(out.output[0]?.base64).toBe("AQID");
        } finally {
            vi.unstubAllGlobals();
        }
    });
});
