import { describe, expect, it, vi } from "vitest";
import { OpenAIVideoDownloadCapabilityImpl } from "#root/providers/openai/capabilities/OpenAIVideoDownloadCapabilityImpl.js";

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

describe("OpenAIVideoDownloadCapabilityImpl", () => {
    it("validates videoId", async () => {
        const provider = makeProvider();
        const client = { videos: { downloadContent: vi.fn() } };
        const cap = new OpenAIVideoDownloadCapabilityImpl(provider, client as any);

        await expect(cap.downloadVideo({ input: {} } as any)).rejects.toThrow("videoId is required for video download");
    });

    it("downloads video bytes and returns normalized artifact", async () => {
        const provider = makeProvider();
        const downloadContent = vi.fn().mockResolvedValue({
            arrayBuffer: vi.fn().mockResolvedValue(Uint8Array.from([1, 2, 3]).buffer)
        });
        const client = { videos: { downloadContent } };
        const cap = new OpenAIVideoDownloadCapabilityImpl(provider, client as any);

        const res = await cap.downloadVideo({
            input: { videoId: "vid_1", variant: "video" },
            context: { requestId: "req_1" }
        } as any);

        expect(provider.ensureInitialized).toHaveBeenCalledTimes(1);
        expect(downloadContent).toHaveBeenCalledWith("vid_1", { variant: "video" }, expect.any(Object));
        expect(res.id).toBe("vid_1:video");
        expect(res.output[0]?.id).toBe("vid_1:video");
        expect(res.output[0]?.mimeType).toBe("video/mp4");
        expect(res.output[0]?.base64).toBe("AQID");
        expect(res.metadata?.sourceVideoId).toBe("vid_1");
        expect(res.metadata?.variant).toBe("video");
    });

    it("uses image mime type for thumbnail/spritesheet variants", async () => {
        const provider = makeProvider();
        const downloadContent = vi.fn().mockResolvedValue({
            arrayBuffer: vi.fn().mockResolvedValue(Uint8Array.from([5, 6]).buffer)
        });
        const client = { videos: { downloadContent } };
        const cap = new OpenAIVideoDownloadCapabilityImpl(provider, client as any);

        const thumb = await cap.downloadVideo({ input: { videoId: "vid_t", variant: "thumbnail" } } as any);
        const sheet = await cap.downloadVideo({ input: { videoId: "vid_s", variant: "spritesheet" } } as any);

        expect(thumb.output[0]?.mimeType).toBe("image/jpeg");
        expect(sheet.output[0]?.mimeType).toBe("image/jpeg");
    });

    it("helper methods cover timeout parsing, mime resolution, and signal composition", () => {
        const cap = new OpenAIVideoDownloadCapabilityImpl(makeProvider(), { videos: { downloadContent: vi.fn() } } as any);

        expect((cap as any).resolveDownloadTimeoutMs(undefined)).toBe(30000);
        expect((cap as any).resolveDownloadTimeoutMs(0)).toBe(30000);
        expect((cap as any).resolveDownloadTimeoutMs("1234.8")).toBe(1234);
        expect((cap as any).resolveDownloadTimeoutMs("bad")).toBe(30000);

        expect((cap as any).resolveMimeTypeForVariant("video")).toBe("video/mp4");
        expect((cap as any).resolveMimeTypeForVariant("thumbnail")).toBe("image/jpeg");
        expect((cap as any).resolveMimeTypeForVariant("spritesheet")).toBe("image/jpeg");

        const aborted = new AbortController();
        aborted.abort();
        const fromAborted = (cap as any).composeSignalWithTimeout(aborted.signal, 1000);
        expect(fromAborted).toBe(aborted.signal);

        const plain = (cap as any).composeSignalWithTimeout(undefined, 1000);
        expect(plain).toBeInstanceOf(AbortSignal);

        const active = new AbortController();
        const composed = (cap as any).composeSignalWithTimeout(active.signal, 1000);
        expect(composed.aborted).toBe(false);
        active.abort();
        expect(composed.aborted).toBe(true);
    });
});
