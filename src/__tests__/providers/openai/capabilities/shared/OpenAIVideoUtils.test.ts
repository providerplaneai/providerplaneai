import { describe, expect, it, vi } from "vitest";
import { delayWithAbort } from "#root/index.js";
import {
    buildOpenAIVideoArtifact,
    buildOpenAIVideoResponseMetadata,
    downloadVariantBase64,
    parseVideoSize,
    pollOpenAIVideoUntilTerminal,
    resolveOpenAIVideoPollingWindow,
    resolveVariantMimeType,
    throwIfFailedVideoStatus
} from "#root/providers/openai/capabilities/shared/OpenAIVideoUtils.js";

describe("OpenAIVideoUtils", () => {
    it("resolveOpenAIVideoPollingWindow clamps poll interval and max poll window", () => {
        const out = resolveOpenAIVideoPollingWindow({
            pollIntervalMs: 1,
            maxPollMs: 5,
            defaultPollIntervalMs: 2000,
            defaultMaxPollMs: 30000
        });
        expect(out.pollIntervalMs).toBe(250);
        expect(out.maxPollMs).toBe(250);
    });

    it("parseVideoSize handles valid and invalid size strings", () => {
        expect(parseVideoSize("1280x720")).toEqual({ width: 1280, height: 720 });
        expect(parseVideoSize("foo")).toEqual({ width: undefined, height: undefined });
    });

    it("resolveVariantMimeType maps variants to expected mime types", () => {
        expect(resolveVariantMimeType("video")).toBe("video/mp4");
        expect(resolveVariantMimeType("thumbnail")).toBe("image/jpeg");
        expect(resolveVariantMimeType("spritesheet")).toBe("image/jpeg");
    });

    it("delayWithAbort resolves immediately for non-positive delays", async () => {
        await expect(delayWithAbort(0, undefined, "aborted")).resolves.toBeUndefined();
    });

    it("delayWithAbort rejects on already-aborted signal", async () => {
        const ac = new AbortController();
        ac.abort();
        await expect(delayWithAbort(10, ac.signal, "aborted")).rejects.toThrow("aborted");
    });

    it("delayWithAbort resolves for active signal and can be aborted after scheduling", async () => {
        const ac = new AbortController();
        await expect(delayWithAbort(1, ac.signal, "aborted")).resolves.toBeUndefined();

        const ac2 = new AbortController();
        const pending = delayWithAbort(50, ac2.signal, "aborted-late");
        ac2.abort();
        await expect(pending).rejects.toThrow("aborted-late");
    });

    it("pollOpenAIVideoUntilTerminal returns terminal payload and uses custom delay", async () => {
        const states = [{ status: "processing" }, { status: "completed", id: "v_1" }];
        const retrieve = vi.fn().mockImplementation(async () => states.shift() ?? { status: "completed" });
        const delay = vi.fn().mockResolvedValue(undefined);

        const out = await pollOpenAIVideoUntilTerminal({
            videoId: "v_1",
            pollIntervalMs: 10,
            maxPollMs: 5000,
            retrieve,
            getStatus: (v) => (v as any).status,
            delay,
            abortMessage: "aborted"
        });

        expect((out as any).status).toBe("completed");
        expect(retrieve).toHaveBeenCalledTimes(2);
        expect(delay).toHaveBeenCalledTimes(1);
    });

    it("pollOpenAIVideoUntilTerminal uses built-in delay helper when custom delay is absent", async () => {
        const states = [{ status: "processing" }, { status: "completed", id: "v_1" }];
        const retrieve = vi.fn().mockImplementation(async () => states.shift() ?? { status: "completed" });

        const out = await pollOpenAIVideoUntilTerminal({
            videoId: "v_1",
            pollIntervalMs: 1,
            maxPollMs: 500,
            retrieve,
            getStatus: (v) => (v as any).status,
            abortMessage: "aborted"
        });

        expect((out as any).status).toBe("completed");
        expect(retrieve).toHaveBeenCalledTimes(2);
    });

    it("pollOpenAIVideoUntilTerminal throws on timeout and abort", async () => {
        const retrieve = vi.fn().mockResolvedValue({ status: "processing" });
        await expect(
            pollOpenAIVideoUntilTerminal({
                videoId: "v_2",
                pollIntervalMs: 5,
                maxPollMs: 0,
                retrieve,
                getStatus: (v) => (v as any).status,
                abortMessage: "aborted"
            })
        ).rejects.toThrow("Timed out");

        const ac = new AbortController();
        ac.abort();
        await expect(
            pollOpenAIVideoUntilTerminal({
                videoId: "v_3",
                pollIntervalMs: 5,
                maxPollMs: 10,
                signal: ac.signal,
                retrieve,
                getStatus: (v) => (v as any).status,
                abortMessage: "aborted"
            })
        ).rejects.toThrow("aborted");
    });

    it("downloadVariantBase64 maps bytes to base64 and handles empty payload", async () => {
        const client = {
            videos: {
                downloadContent: vi
                    .fn()
                    .mockResolvedValueOnce({ headers: { get: () => null }, body: { getReader: () => { let done = false; return { read: async () => done ? { done: true, value: undefined } : (done = true, { done: false, value: Uint8Array.from([1, 2, 3]) }) }; } } })
                    .mockResolvedValueOnce({ headers: { get: () => null }, body: { getReader: () => ({ read: async () => ({ done: true, value: undefined }) }) } })
            }
        } as any;

        await expect(downloadVariantBase64(client, "vid_1", "video")).resolves.toBe("AQID");
        await expect(downloadVariantBase64(client, "vid_1", "video")).resolves.toBeUndefined();
    });

    it("throwIfFailedVideoStatus throws normalized errors for failed payloads", () => {
        expect(() => throwIfFailedVideoStatus({ status: "completed" }, "generation")).not.toThrow();
        expect(() =>
            throwIfFailedVideoStatus({ status: "failed", error: { code: "x", message: "boom" } }, "remix")
        ).toThrow("Video remix failed [x]: boom");
        expect(() => throwIfFailedVideoStatus({ status: "failed", error: null }, "generation")).toThrow("unknown error");
    });

    it("buildOpenAIVideoArtifact and response metadata normalize shared shape", () => {
        const artifact = buildOpenAIVideoArtifact({
            id: "v_4",
            variant: "video",
            base64: "AQID",
            durationSeconds: 8,
            size: "1280x720",
            raw: { foo: "bar" },
            model: "sora-2",
            status: "completed",
            requestId: "req_1",
            extraMetadata: { operation: "generation" }
        });

        expect(artifact.mimeType).toBe("video/mp4");
        expect(artifact.width).toBe(1280);
        expect(artifact.height).toBe(720);
        expect((artifact.metadata as any).operation).toBe("generation");

        const meta = buildOpenAIVideoResponseMetadata({
            contextMetadata: { source: "test" },
            model: "sora-2",
            status: "completed",
            requestId: "req_1",
            progress: 100,
            createdAt: 1,
            completedAt: 2,
            expiresAt: 3,
            extraMetadata: { capability: "videoGeneration" }
        });

        expect(meta).toMatchObject({
            source: "test",
            model: "sora-2",
            status: "completed",
            requestId: "req_1",
            capability: "videoGeneration"
        });
    });
});
