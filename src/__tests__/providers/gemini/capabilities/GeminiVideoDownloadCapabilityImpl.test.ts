import { writeFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { GeminiVideoDownloadCapabilityImpl } from "#root/providers/gemini/capabilities/GeminiVideoDownloadCapabilityImpl.js";

function makeProvider() {
    return {
        ensureInitialized: vi.fn()
    } as any;
}

describe("GeminiVideoDownloadCapabilityImpl", () => {
    it("validates download source input", async () => {
        const provider = makeProvider();
        const cap = new GeminiVideoDownloadCapabilityImpl(provider, { files: {} } as any);
        await expect(cap.downloadVideo({ input: {} } as any)).rejects.toThrow("videoUri or videoId is required");
    });

    it("downloads from data uri", async () => {
        const provider = makeProvider();
        const cap = new GeminiVideoDownloadCapabilityImpl(provider, { files: {} } as any);

        const out = await cap.downloadVideo({
            input: { videoUri: "data:video/mp4;base64,AQID" }
        } as any);

        expect(out.output[0]?.base64).toBe("AQID");
        expect(out.output[0]?.mimeType).toBe("video/mp4");
    });

    it("downloads via files.download for provider file refs", async () => {
        const provider = makeProvider();
        const download = vi.fn(async ({ downloadPath }: { downloadPath: string }) => {
            await writeFile(downloadPath, Buffer.from([1, 2, 3]));
        });
        const cap = new GeminiVideoDownloadCapabilityImpl(provider, { files: { download } } as any);

        const out = await cap.downloadVideo({
            input: { videoId: "files/abc123" }
        } as any);

        expect(download).toHaveBeenCalledTimes(1);
        expect(out.output[0]?.base64).toBe("AQID");
    });

    it("falls back to files.download when URL fetch is forbidden and file ref can be derived", async () => {
        const provider = makeProvider();
        const download = vi.fn(async ({ downloadPath }: { downloadPath: string }) => {
            await writeFile(downloadPath, Buffer.from([1, 2, 3]));
        });
        const cap = new GeminiVideoDownloadCapabilityImpl(provider, { files: { download } } as any);
        vi.stubGlobal(
            "fetch",
            vi.fn().mockResolvedValue({ ok: false, status: 403, statusText: "Forbidden" } as Partial<Response>)
        );

        try {
            const out = await cap.downloadVideo({
                input: { videoUri: "https://example.com/v1beta/files/abc123:download" }
            } as any);
            expect(download).toHaveBeenCalledTimes(1);
            expect(out.output[0]?.base64).toBe("AQID");
        } finally {
            vi.unstubAllGlobals();
        }
    });

    it("throws when protected URL cannot be mapped to a Gemini file name", async () => {
        const provider = makeProvider();
        const cap = new GeminiVideoDownloadCapabilityImpl(provider, { files: {} } as any);
        vi.stubGlobal(
            "fetch",
            vi.fn().mockResolvedValue({ ok: false, status: 403, statusText: "Forbidden" } as Partial<Response>)
        );
        try {
            await expect(
                cap.downloadVideo({ input: { videoUri: "https://example.com/videos/not-a-file-id" } } as any)
            ).rejects.toThrow("Failed to fetch video URI: 403 Forbidden");
        } finally {
            vi.unstubAllGlobals();
        }
    });
});
