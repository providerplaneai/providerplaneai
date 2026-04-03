import { describe, expect, it, vi } from "vitest";
import { delayWithAbort } from "#root/index.js";
import { parseVideoSize, resolveVariantMimeType } from "#root/providers/openai/capabilities/shared/OpenAIVideoUtils.js";
import { OpenAIVideoRemixCapabilityImpl } from "#root/providers/openai/capabilities/OpenAIVideoRemixCapabilityImpl.js";

function makeProvider() {
    return {
        ensureInitialized: vi.fn(),
        getMergedOptions: vi.fn().mockReturnValue({})
    } as any;
}

describe("OpenAIVideoRemixCapabilityImpl", () => {
    it("validates sourceVideoId and prompt input", async () => {
        const provider = makeProvider();
        const client = { videos: { remix: vi.fn() } };
        const cap = new OpenAIVideoRemixCapabilityImpl(provider, client as any);

        await expect(cap.remixVideo({ input: { prompt: "x" } } as any)).rejects.toThrow(
            "sourceVideoId is required for video remix"
        );
        await expect(cap.remixVideo({ input: { sourceVideoId: "vid_1" } } as any)).rejects.toThrow(
            "Prompt is required for video remix"
        );
    });

    it("returns remixed video output when pollUntilComplete is false", async () => {
        const provider = makeProvider();
        const remix = vi.fn().mockResolvedValue({
            id: "vid_remix_1",
            model: "sora-2",
            status: "queued",
            seconds: "4",
            size: "1280x720",
            progress: 0,
            created_at: 1000,
            completed_at: null,
            expires_at: null,
            remixed_from_video_id: "vid_source_123",
            error: null
        });
        const client = {
            videos: {
                remix,
                retrieve: vi.fn(),
                downloadContent: vi.fn()
            }
        };

        const cap = new OpenAIVideoRemixCapabilityImpl(provider, client as any);
        const res = await cap.remixVideo({
            input: {
                sourceVideoId: "vid_source_123",
                prompt: "Make it dusk",
                params: { pollUntilComplete: false }
            },
            context: { requestId: "r1" }
        } as any);

        expect(provider.ensureInitialized).toHaveBeenCalledTimes(1);
        expect(remix).toHaveBeenCalledWith("vid_source_123", { prompt: "Make it dusk" }, expect.any(Object));
        expect(res.id).toBe("vid_remix_1");
        expect(res.output[0]?.metadata?.remixedFromVideoId).toBe("vid_source_123");
    });

    it("polls until completed and optionally downloads base64 output", async () => {
        vi.useFakeTimers();
        const provider = makeProvider();
        const remix = vi.fn().mockResolvedValue({
            id: "vid_remix_2",
            model: "sora-2",
            status: "queued",
            seconds: "8",
            size: "720x1280",
            progress: 0,
            created_at: 1000,
            completed_at: null,
            expires_at: null,
            remixed_from_video_id: "vid_source_555",
            error: null
        });
        const retrieve = vi
            .fn()
            .mockResolvedValueOnce({
                id: "vid_remix_2",
                model: "sora-2",
                status: "in_progress",
                seconds: "8",
                size: "720x1280",
                progress: 60,
                created_at: 1000,
                completed_at: null,
                expires_at: null,
                remixed_from_video_id: "vid_source_555",
                error: null
            })
            .mockResolvedValueOnce({
                id: "vid_remix_2",
                model: "sora-2",
                status: "completed",
                seconds: "8",
                size: "720x1280",
                progress: 100,
                created_at: 1000,
                completed_at: 2000,
                expires_at: 3000,
                remixed_from_video_id: "vid_source_555",
                error: null
            });
        const downloadContent = vi.fn().mockResolvedValue({
            headers: { get: () => null },
            body: { getReader: () => { let done = false; return { read: async () => done ? { done: true, value: undefined } : (done = true, { done: false, value: Uint8Array.from([1, 2, 3]) }) }; } }
        });
        const client = {
            videos: { remix, retrieve, downloadContent }
        };

        try {
            const cap = new OpenAIVideoRemixCapabilityImpl(provider, client as any);
            const resPromise = cap.remixVideo({
                input: {
                    sourceVideoId: "vid_source_555",
                    prompt: "Make it cinematic",
                    params: { pollUntilComplete: true, includeBase64: true, downloadVariant: "video" }
                }
            } as any);
            await vi.advanceTimersByTimeAsync(2_000);
            const res = await resPromise;

            expect(retrieve).toHaveBeenCalledTimes(2);
            expect(downloadContent).toHaveBeenCalledWith("vid_remix_2", { variant: "video" }, expect.any(Object));
            expect(res.output[0]?.base64).toBe("AQID");
            expect(res.metadata?.status).toBe("completed");
        } finally {
            vi.useRealTimers();
        }
    });

    it("throws a descriptive error when remix fails", async () => {
        const provider = makeProvider();
        const remix = vi.fn().mockResolvedValue({
            id: "vid_remix_3",
            model: "sora-2",
            status: "failed",
            seconds: "4",
            size: "1280x720",
            progress: 100,
            created_at: 1000,
            completed_at: 1100,
            expires_at: null,
            remixed_from_video_id: "vid_source_777",
            error: { code: "policy", message: "blocked" }
        });
        const client = {
            videos: {
                remix,
                retrieve: vi.fn().mockResolvedValue({
                    id: "vid_remix_3",
                    model: "sora-2",
                    status: "failed",
                    seconds: "4",
                    size: "1280x720",
                    progress: 100,
                    created_at: 1000,
                    completed_at: 1100,
                    expires_at: null,
                    remixed_from_video_id: "vid_source_777",
                    error: { code: "policy", message: "blocked" }
                }),
                downloadContent: vi.fn()
            }
        };
        const cap = new OpenAIVideoRemixCapabilityImpl(provider, client as any);

        await expect(
            cap.remixVideo({
                input: { sourceVideoId: "vid_source_777", prompt: "forbidden content" }
            } as any)
        ).rejects.toThrow("Video remix failed [policy]: blocked");
    });

    it("shared helpers cover size parsing, mime mapping, and abort-aware delay", async () => {
        expect(parseVideoSize("720x1280")).toEqual({ width: 720, height: 1280 });
        expect(parseVideoSize("bad")).toEqual({ width: undefined, height: undefined });

        expect(resolveVariantMimeType("video")).toBe("video/mp4");
        expect(resolveVariantMimeType("thumbnail")).toBe("image/jpeg");
        expect(resolveVariantMimeType("spritesheet")).toBe("image/jpeg");

        await expect(delayWithAbort(0, undefined, "Video remix polling aborted")).resolves.toBeUndefined();
        const ac = new AbortController();
        ac.abort();
        await expect(delayWithAbort(25, ac.signal, "Video remix polling aborted")).rejects.toThrow(
            "Video remix polling aborted"
        );
    });
});
