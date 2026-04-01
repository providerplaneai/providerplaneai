import { describe, expect, it, vi } from "vitest";
import { delayWithAbort, toOpenAIReferenceImageFile } from "#root/index.js";
import { parseVideoSize, resolveVariantMimeType } from "#root/providers/openai/capabilities/shared/OpenAIVideoUtils.js";
import { OpenAIVideoGenerationCapabilityImpl } from "#root/providers/openai/capabilities/OpenAIVideoGenerationCapabilityImpl.js";

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

describe("OpenAIVideoGenerationCapabilityImpl", () => {
    it("validates prompt input", async () => {
        const provider = makeProvider();
        const client = { videos: { create: vi.fn() } };
        const cap = new OpenAIVideoGenerationCapabilityImpl(provider, client as any);

        await expect(cap.generateVideo({ input: {} } as any)).rejects.toThrow("Prompt is required for video generation");
    });

    it("fails fast when referenceImage.url is used", async () => {
        const provider = makeProvider();
        const client = { videos: { create: vi.fn() } };
        const cap = new OpenAIVideoGenerationCapabilityImpl(provider, client as any);

        await expect(
            cap.generateVideo({
                input: { prompt: "hello", referenceImage: { id: "r1", sourceType: "url", url: "https://example.com/r.png" } }
            } as any)
        ).rejects.toThrow("OpenAI video input_reference requires uploaded image content");
    });

    it("returns created video output when pollUntilComplete is false", async () => {
        const provider = makeProvider();
        const create = vi.fn().mockResolvedValue({
            id: "vid_1",
            model: "sora-2",
            status: "queued",
            seconds: "4",
            size: "1280x720",
            progress: 0,
            created_at: 1000,
            completed_at: null,
            expires_at: null,
            error: null
        });
        const client = {
            videos: {
                create,
                retrieve: vi.fn(),
                downloadContent: vi.fn()
            }
        };

        const cap = new OpenAIVideoGenerationCapabilityImpl(provider, client as any);
        const res = await cap.generateVideo({
            input: { prompt: "sunrise", params: { pollUntilComplete: false } },
            context: { requestId: "r1", metadata: { trace: "x" } }
        } as any);

        expect(provider.ensureInitialized).toHaveBeenCalledTimes(1);
        expect(create).toHaveBeenCalledWith(expect.objectContaining({ prompt: "sunrise" }), expect.any(Object));
        expect(res.id).toBe("vid_1");
        expect(res.output[0]?.id).toBe("vid_1");
        expect(res.output[0]?.mimeType).toBe("video/mp4");
        expect(res.output[0]?.width).toBe(1280);
        expect(res.output[0]?.height).toBe(720);
        expect(res.output[0]?.durationSeconds).toBe(4);
        expect(res.metadata?.status).toBe("queued");
    });

    it("polls until completed and optionally downloads base64 output", async () => {
        vi.useFakeTimers();
        const provider = makeProvider();
        const create = vi.fn().mockResolvedValue({
            id: "vid_2",
            model: "sora-2",
            status: "queued",
            seconds: "8",
            size: "720x1280",
            progress: 0,
            created_at: 1000,
            completed_at: null,
            expires_at: null,
            error: null
        });
        const retrieve = vi
            .fn()
            .mockResolvedValueOnce({
                id: "vid_2",
                model: "sora-2",
                status: "in_progress",
                seconds: "8",
                size: "720x1280",
                progress: 60,
                created_at: 1000,
                completed_at: null,
                expires_at: null,
                error: null
            })
            .mockResolvedValueOnce({
                id: "vid_2",
                model: "sora-2",
                status: "completed",
                seconds: "8",
                size: "720x1280",
                progress: 100,
                created_at: 1000,
                completed_at: 2000,
                expires_at: 3000,
                error: null
            });
        const downloadContent = vi.fn().mockResolvedValue({
            arrayBuffer: vi.fn().mockResolvedValue(Uint8Array.from([1, 2, 3]).buffer)
        });
        const client = {
            videos: { create, retrieve, downloadContent }
        };

        try {
            const cap = new OpenAIVideoGenerationCapabilityImpl(provider, client as any);
            const resPromise = cap.generateVideo({
                input: {
                    prompt: "ocean waves",
                    params: { pollUntilComplete: true, includeBase64: true, downloadVariant: "video" }
                }
            } as any);
            await vi.advanceTimersByTimeAsync(2_000);
            const res = await resPromise;

            expect(retrieve).toHaveBeenCalledTimes(2);
            expect(downloadContent).toHaveBeenCalledWith("vid_2", { variant: "video" }, expect.any(Object));
            expect(res.output[0]?.base64).toBe("AQID");
            expect(res.metadata?.status).toBe("completed");
        } finally {
            vi.useRealTimers();
        }
    });

    it("throws a descriptive error when video generation fails", async () => {
        const provider = makeProvider();
        const create = vi.fn().mockResolvedValue({
            id: "vid_3",
            model: "sora-2",
            status: "failed",
            seconds: "4",
            size: "1280x720",
            progress: 100,
            created_at: 1000,
            completed_at: 1100,
            expires_at: null,
            error: { code: "policy", message: "blocked" }
        });
        const client = {
            videos: {
                create,
                retrieve: vi.fn().mockResolvedValue({
                    id: "vid_3",
                    model: "sora-2",
                    status: "failed",
                    seconds: "4",
                    size: "1280x720",
                    progress: 100,
                    created_at: 1000,
                    completed_at: 1100,
                    expires_at: null,
                    error: { code: "policy", message: "blocked" }
                }),
                downloadContent: vi.fn()
            }
        };
        const cap = new OpenAIVideoGenerationCapabilityImpl(provider, client as any);

        await expect(cap.generateVideo({ input: { prompt: "forbidden content" } } as any)).rejects.toThrow(
            "Video generation failed [policy]: blocked"
        );
    });

    it("times out while polling when terminal status is not reached", async () => {
        vi.useFakeTimers();
        const provider = makeProvider();
        const create = vi.fn().mockResolvedValue({
            id: "vid_4",
            model: "sora-2",
            status: "queued",
            seconds: "4",
            size: "1280x720",
            progress: 0,
            created_at: 1000,
            completed_at: null,
            expires_at: null,
            error: null
        });
        const retrieve = vi.fn().mockResolvedValue({
            id: "vid_4",
            model: "sora-2",
            status: "in_progress",
            seconds: "4",
            size: "1280x720",
            progress: 10,
            created_at: 1000,
            completed_at: null,
            expires_at: null,
            error: null
        });
        const client = {
            videos: { create, retrieve, downloadContent: vi.fn() }
        };
        const cap = new OpenAIVideoGenerationCapabilityImpl(provider, client as any);

        let now = 0;
        const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => {
            now += 1000;
            return now;
        });

        try {
            const pending = cap.generateVideo({
                input: {
                    prompt: "slow video",
                    params: { pollUntilComplete: true, pollIntervalMs: 250, maxPollMs: 1200 }
                }
            } as any);
            const rejection = expect(pending).rejects.toThrow("Timed out waiting for video job 'vid_4' to complete");

            await vi.advanceTimersByTimeAsync(250);
            await rejection;
        } finally {
            nowSpy.mockRestore();
            vi.useRealTimers();
        }
    });

    it("shared helpers cover parsing, mime mapping, delay, and input reference branches", async () => {
        expect(parseVideoSize("1280x720")).toEqual({ width: 1280, height: 720 });
        expect(parseVideoSize("bad")).toEqual({ width: undefined, height: undefined });

        expect(resolveVariantMimeType("video")).toBe("video/mp4");
        expect(resolveVariantMimeType("thumbnail")).toBe("image/jpeg");
        expect(resolveVariantMimeType("spritesheet")).toBe("image/jpeg");

        await expect(delayWithAbort(0, undefined, "Video generation polling aborted")).resolves.toBeUndefined();
        const ac = new AbortController();
        ac.abort();
        await expect(delayWithAbort(10, ac.signal, "Video generation polling aborted")).rejects.toThrow(
            "Video generation polling aborted"
        );

        await expect(
            toOpenAIReferenceImageFile(
                undefined,
                "video-reference.png",
                "OpenAI video input_reference requires uploaded image content; pass referenceImage.base64 (+ mimeType) instead of url",
                "referenceImage must include either base64 data or be omitted"
            )
        ).resolves.toBeUndefined();
        await expect(
            toOpenAIReferenceImageFile(
                { id: "x", sourceType: "base64", base64: "AQID" } as any,
                "video-reference.png",
                "OpenAI video input_reference requires uploaded image content; pass referenceImage.base64 (+ mimeType) instead of url",
                "referenceImage must include either base64 data or be omitted"
            )
        ).resolves.toBeTruthy();
        await expect(
            toOpenAIReferenceImageFile(
                { id: "x", sourceType: "url", url: "https://example.com/x.png" } as any,
                "video-reference.png",
                "OpenAI video input_reference requires uploaded image content; pass referenceImage.base64 (+ mimeType) instead of url",
                "referenceImage must include either base64 data or be omitted"
            )
        ).rejects.toThrow(
            "OpenAI video input_reference requires uploaded image content"
        );
        await expect(
            toOpenAIReferenceImageFile(
                { id: "x", sourceType: "base64" } as any,
                "video-reference.png",
                "OpenAI video input_reference requires uploaded image content; pass referenceImage.base64 (+ mimeType) instead of url",
                "referenceImage must include either base64 data or be omitted"
            )
        ).rejects.toThrow(
            "referenceImage must include either base64 data or be omitted"
        );
    });
});
