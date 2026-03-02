import { describe, expect, it, vi } from "vitest";
import { OpenAIVideoDownloadCapabilityImpl } from "#root/providers/openai/capabilities/OpenAIVideoDownloadCapabilityImpl.js";

function makeProvider() {
    return {
        ensureInitialized: vi.fn()
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
});
