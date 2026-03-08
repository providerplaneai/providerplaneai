import { writeFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { GeminiVideoDownloadCapabilityImpl } from "#root/providers/gemini/capabilities/GeminiVideoDownloadCapabilityImpl.js";

function makeProvider() {
    return {
        ensureInitialized: vi.fn(),
        getMergedOptions: vi.fn().mockReturnValue({
            generalParams: {
                downloadTimeoutMs: 30000
            }
        })
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

    it("downloads directly from fetchable URL and keeps source URL on artifact", async () => {
        const provider = makeProvider();
        const cap = new GeminiVideoDownloadCapabilityImpl(provider, { files: {} } as any);
        vi.stubGlobal(
            "fetch",
            vi.fn().mockResolvedValue({
                ok: true,
                arrayBuffer: vi.fn().mockResolvedValue(Uint8Array.from([9, 8, 7]).buffer)
            } as Partial<Response>)
        );

        try {
            const out = await cap.downloadVideo({
                input: { videoUri: "https://example.com/video.mp4" }
            } as any);
            expect(out.output[0]?.url).toBe("https://example.com/video.mp4");
            expect(out.output[0]?.base64).toBe("CQgH");
        } finally {
            vi.unstubAllGlobals();
        }
    });

    it("throws on non-auth fetch failure status", async () => {
        const provider = makeProvider();
        const cap = new GeminiVideoDownloadCapabilityImpl(provider, { files: {} } as any);
        vi.stubGlobal(
            "fetch",
            vi.fn().mockResolvedValue({ ok: false, status: 500, statusText: "Server Error" } as Partial<Response>)
        );
        try {
            await expect(cap.downloadVideo({ input: { videoUri: "https://example.com/video.mp4" } } as any)).rejects.toThrow(
                "Failed to fetch video URI: 500 Server Error"
            );
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

    it("helper methods cover mime resolution, timeout defaults, and signal composition", () => {
        const cap = new GeminiVideoDownloadCapabilityImpl(makeProvider(), { files: {} } as any);

        expect((cap as any).resolveMimeType("data:image/png;base64,AA==")).toBe("image/jpeg");
        expect((cap as any).resolveMimeType("https://example.com/image.jpg")).toBe("image/jpeg");
        expect((cap as any).resolveMimeType("https://example.com/video.mp4")).toBe("video/mp4");

        expect((cap as any).resolveDownloadTimeoutMs(undefined)).toBe(30000);
        expect((cap as any).resolveDownloadTimeoutMs("2500")).toBe(2500);
        expect((cap as any).resolveDownloadTimeoutMs("-1")).toBe(30000);

        const composed = (cap as any).composeSignalWithTimeout(undefined, 1000);
        expect(composed).toBeInstanceOf(AbortSignal);

        const ac = new AbortController();
        ac.abort();
        const passthrough = (cap as any).composeSignalWithTimeout(ac.signal, 1000);
        expect(passthrough).toBe(ac.signal);

        const active = new AbortController();
        const composedActive = (cap as any).composeSignalWithTimeout(active.signal, 1000);
        expect(composedActive.aborted).toBe(false);
        active.abort();
        expect(composedActive.aborted).toBe(true);
    });

    it("downloadViaFilesApi surfaces generic error when all attempts fail with non-Error values", async () => {
        const provider = makeProvider();
        const cap = new GeminiVideoDownloadCapabilityImpl(
            provider,
            {
                files: {
                    download: vi.fn().mockRejectedValue("non-error rejection")
                }
            } as any
        );

        await expect((cap as any).downloadViaFilesApi("files/abc123")).rejects.toThrow(
            "Gemini files.download failed for all attempted file reference formats"
        );
    });
});
