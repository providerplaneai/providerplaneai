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

    it("throws when referenceImage is present without url/base64", async () => {
        const provider = makeProvider();
        const cap = new GeminiVideoGenerationCapabilityImpl(provider, { models: {}, operations: {} } as any);
        await expect(
            cap.generateVideo({
                input: { prompt: "x", referenceImage: { id: "r1", sourceType: "url" } as any }
            } as any)
        ).rejects.toThrow("referenceImage must include url or base64");
    });

    it("throws when operation completes with error or missing generated video", async () => {
        const provider = makeProvider();
        const generateVideos = vi.fn().mockResolvedValueOnce({
            done: true,
            name: "operations/gv-err",
            error: { code: 400, message: "bad request" }
        });
        const capErr = new GeminiVideoGenerationCapabilityImpl(provider, { models: { generateVideos }, operations: {} } as any);
        await expect(capErr.generateVideo({ input: { prompt: "x", params: { pollUntilComplete: false } } } as any)).rejects.toThrow(
            "Gemini video generation failed:"
        );

        generateVideos.mockResolvedValueOnce({
            done: true,
            name: "operations/gv-missing",
            response: { generatedVideos: [] }
        });
        const capMissing = new GeminiVideoGenerationCapabilityImpl(provider, { models: { generateVideos }, operations: {} } as any);
        await expect(
            capMissing.generateVideo({ input: { prompt: "x", params: { pollUntilComplete: false } } } as any)
        ).rejects.toThrow("Gemini video generation response did not include a generated video");
    });

    it("polls until done and can include inline base64", async () => {
        vi.useFakeTimers();
        try {
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

            const outPromise = cap.generateVideo({
                input: { prompt: "A sunset", params: { includeBase64: true } }
            } as any);
            await vi.advanceTimersByTimeAsync(2_000);
            const out = await outPromise;

            expect(getVideosOperation).toHaveBeenCalledTimes(1);
            expect(out.output[0]?.base64).toBe("AQID");
        } finally {
            vi.useRealTimers();
        }
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

    it("helper methods cover duration, aspect ratio, filename extraction, and delay branches", async () => {
        const cap = new GeminiVideoGenerationCapabilityImpl(makeProvider(), { models: {}, operations: {} } as any);

        expect((cap as any).resolveDuration(undefined)).toBeUndefined();
        expect((cap as any).resolveDuration("5")).toBe(5);
        expect((cap as any).resolveDuration("abc")).toBeUndefined();
        expect(() => (cap as any).resolveDuration("3")).toThrow("between 4 and 8");

        expect((cap as any).mapSizeToAspectRatio(undefined)).toBeUndefined();
        expect((cap as any).mapSizeToAspectRatio("1280x720")).toBe("16:9");
        expect((cap as any).mapSizeToAspectRatio("1792x1024")).toBe("16:9");
        expect((cap as any).mapSizeToAspectRatio("720x1280")).toBe("9:16");
        expect((cap as any).mapSizeToAspectRatio("1024x1792")).toBe("9:16");
        expect((cap as any).mapSizeToAspectRatio("1x1")).toBeUndefined();

        expect((cap as any).extractGeminiFileName("files/abc-123")).toBe("abc-123");
        expect((cap as any).extractGeminiFileName("https://x/v1beta/files/abc123:download")).toBe("abc123");
        expect((cap as any).extractGeminiFileName("https://x/?name=files%2Fabc123")).toBe("abc123");
        expect((cap as any).extractGeminiFileName("https://x/not-file")).toBeUndefined();

        await expect((cap as any).delay(0, undefined)).resolves.toBeUndefined();
        const ac = new AbortController();
        ac.abort();
        await expect((cap as any).delay(5, ac.signal)).rejects.toThrow("polling aborted");
    });

    it("resolveVideoBase64 handles data/http/fail/non-http branches", async () => {
        const cap = new GeminiVideoGenerationCapabilityImpl(makeProvider(), { models: {}, operations: {} } as any);

        await expect((cap as any).resolveVideoBase64({ videoBytes: "AQID" })).resolves.toBe("AQID");
        await expect((cap as any).resolveVideoBase64({ uri: "data:video/mp4;base64,BAUG" })).resolves.toBe("BAUG");

        vi.stubGlobal(
            "fetch",
            vi.fn().mockResolvedValue({
                ok: true,
                arrayBuffer: vi.fn().mockResolvedValue(Uint8Array.from([9, 8]).buffer)
            } as Partial<Response>)
        );
        await expect((cap as any).resolveVideoBase64({ uri: "https://example.com/v.mp4" })).resolves.toBe("CQg=");

        vi.stubGlobal(
            "fetch",
            vi.fn().mockResolvedValue({ ok: false, status: 500, statusText: "Server Error" } as Partial<Response>)
        );
        await expect((cap as any).resolveVideoBase64({ uri: "https://example.com/v.mp4" })).rejects.toThrow(
            "Failed to fetch generated video from URI: 500 Server Error"
        );

        vi.unstubAllGlobals();
        await expect((cap as any).resolveVideoBase64({ uri: "files/invalid_name_" })).rejects.toThrow(
            "Gemini video download requires a valid file reference"
        );
    });

    it("downloadViaFilesApi retries refs and surfaces last failure", async () => {
        const download = vi
            .fn()
            .mockRejectedValueOnce(new Error("first failed"))
            .mockRejectedValueOnce(new Error("second failed"));
        const cap = new GeminiVideoGenerationCapabilityImpl(makeProvider(), {
            models: {},
            operations: {},
            files: { download }
        } as any);

        await expect((cap as any).downloadViaFilesApi("files/abc123")).rejects.toThrow("second failed");
    });

    it("covers fallback ids, default mime, empty base64 fetch response, and polling abort/timeout", async () => {
        const provider = makeProvider();
        provider.getMergedOptions = vi.fn().mockReturnValue({
            model: undefined,
            modelParams: undefined,
            providerParams: undefined,
            generalParams: { pollIntervalMs: 1, maxPollMs: 5 }
        });

        const generateVideos = vi.fn().mockResolvedValue({
            done: true,
            response: {
                generatedVideos: [{ video: { uri: "https://example.com/v.mp4" } }]
            }
        });
        const cap = new GeminiVideoGenerationCapabilityImpl(provider, { models: { generateVideos }, operations: {} } as any);
        vi.stubGlobal(
            "fetch",
            vi.fn().mockResolvedValue({
                ok: true,
                arrayBuffer: vi.fn().mockResolvedValue(new Uint8Array(0).buffer)
            } as Partial<Response>)
        );
        try {
            const out = await cap.generateVideo({
                input: { prompt: "x", params: { pollUntilComplete: false, includeBase64: true } }
            } as any);
            expect(out.id).toBeTypeOf("string");
            expect(out.output[0]?.mimeType).toBe("video/mp4");
            expect(out.output[0]?.base64).toBeUndefined();
        } finally {
            vi.unstubAllGlobals();
        }

        const pollCap = new GeminiVideoGenerationCapabilityImpl(
            makeProvider(),
            {
                models: {},
                operations: { getVideosOperation: vi.fn().mockResolvedValue({ done: false, name: "op-timeout" }) }
            } as any
        );
        const ac = new AbortController();
        ac.abort();
        await expect((pollCap as any).pollUntilTerminal({ done: false, name: "op-abort" }, 1, 100, ac.signal)).rejects.toThrow(
            "Gemini video generation polling aborted"
        );

        const nowSpy = vi.spyOn(Date, "now");
        nowSpy.mockReturnValueOnce(0).mockReturnValueOnce(1000);
        await expect((pollCap as any).pollUntilTerminal({ done: false, name: "op-timeout" }, 1, 10)).rejects.toThrow(
            "Timed out waiting for Gemini video operation 'op-timeout'"
        );
        nowSpy.mockRestore();
    });
});
