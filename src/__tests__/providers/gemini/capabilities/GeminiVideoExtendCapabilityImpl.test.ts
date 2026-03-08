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

    it("throws when operation completes with error or missing generated video", async () => {
        const provider = makeProvider();
        const generateVideos = vi.fn().mockResolvedValueOnce({
            done: true,
            name: "operations/ge-err",
            error: { code: 400, message: "bad request" }
        });
        const capErr = new GeminiVideoExtendCapabilityImpl(provider, { models: { generateVideos }, operations: {} } as any);
        await expect(
            capErr.extendVideo({
                input: {
                    sourceVideoUri: "gs://bucket/input.mp4",
                    params: { pollUntilComplete: false, durationSeconds: 5 }
                }
            } as any)
        ).rejects.toThrow("Gemini video extension failed");

        generateVideos.mockResolvedValueOnce({
            done: true,
            name: "operations/ge-missing",
            response: { generatedVideos: [] }
        });
        const capMissing = new GeminiVideoExtendCapabilityImpl(provider, { models: { generateVideos }, operations: {} } as any);
        await expect(
            capMissing.extendVideo({
                input: {
                    sourceVideoUri: "gs://bucket/input.mp4",
                    params: { pollUntilComplete: false, durationSeconds: 5 }
                }
            } as any)
        ).rejects.toThrow("Gemini video extension response did not include a generated video");
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

    it("helper methods cover duration parsing, finite-number parsing, filename extraction, and delay branches", async () => {
        const cap = new GeminiVideoExtendCapabilityImpl(makeProvider(), { models: {}, operations: {} } as any);

        expect((cap as any).readFiniteNumber(5)).toBe(5);
        expect((cap as any).readFiniteNumber("6")).toBe(6);
        expect((cap as any).readFiniteNumber("abc")).toBeUndefined();
        expect((cap as any).readFiniteNumber(undefined)).toBeUndefined();

        expect((cap as any).resolveDurationSeconds(undefined)).toBeUndefined();
        expect((cap as any).resolveDurationSeconds(5)).toBe(5);
        expect(() => (cap as any).resolveDurationSeconds(Number.NaN)).toThrow("finite number");
        expect(() => (cap as any).resolveDurationSeconds(9)).toThrow("between 4 and 8");

        expect((cap as any).extractGeminiFileName("files/abc-123")).toBe("abc-123");
        expect((cap as any).extractGeminiFileName("https://x/v1beta/files/abc123:download")).toBe("abc123");
        expect((cap as any).extractGeminiFileName("https://x/?name=files%2Fabc123")).toBe("abc123");
        expect((cap as any).extractGeminiFileName("https://x/not-file")).toBeUndefined();

        await expect((cap as any).delay(0, undefined)).resolves.toBeUndefined();
        const ac = new AbortController();
        ac.abort();
        await expect((cap as any).delay(5, ac.signal)).rejects.toThrow("polling aborted");
    });

    it("resolveVideoBase64 covers data-uri/http-success/http-failure/non-http branches", async () => {
        const cap = new GeminiVideoExtendCapabilityImpl(makeProvider(), { models: {}, operations: {} } as any);

        await expect((cap as any).resolveVideoBase64({ videoBytes: "AQID" })).resolves.toBe("AQID");
        await expect((cap as any).resolveVideoBase64({ uri: "data:video/mp4;base64,BAUG" })).resolves.toBe("BAUG");

        vi.stubGlobal(
            "fetch",
            vi.fn().mockResolvedValue({
                ok: true,
                arrayBuffer: vi.fn().mockResolvedValue(Uint8Array.from([1, 2]).buffer)
            } as Partial<Response>)
        );
        await expect((cap as any).resolveVideoBase64({ uri: "https://example.com/v.mp4" })).resolves.toBe("AQI=");

        vi.stubGlobal(
            "fetch",
            vi.fn().mockResolvedValue({ ok: false, status: 500, statusText: "Server Error" } as Partial<Response>)
        );
        await expect((cap as any).resolveVideoBase64({ uri: "https://example.com/v.mp4" })).rejects.toThrow(
            "Failed to fetch extended video from URI: 500 Server Error"
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
        const cap = new GeminiVideoExtendCapabilityImpl(makeProvider(), {
            models: {},
            operations: {},
            files: { download }
        } as any);

        await expect((cap as any).downloadViaFilesApi("files/abc123")).rejects.toThrow("second failed");
    });

    it("covers polling abort/timeout, empty fetch bytes, and generic files API failure", async () => {
        const cap = new GeminiVideoExtendCapabilityImpl(
            makeProvider(),
            {
                models: {},
                operations: { getVideosOperation: vi.fn().mockResolvedValue({ done: false, name: "op-timeout" }) },
                files: { download: vi.fn().mockRejectedValue("non-error failure") }
            } as any
        );

        const ac = new AbortController();
        ac.abort();
        await expect((cap as any).pollUntilTerminal({ done: false, name: "op-abort" }, 1, 100, ac.signal)).rejects.toThrow(
            "Gemini video extension polling aborted"
        );

        const nowSpy = vi.spyOn(Date, "now");
        nowSpy.mockReturnValueOnce(0).mockReturnValueOnce(1000);
        await expect((cap as any).pollUntilTerminal({ done: false, name: "op-timeout" }, 1, 10)).rejects.toThrow(
            "Timed out waiting for Gemini video operation 'op-timeout'"
        );
        nowSpy.mockRestore();

        vi.stubGlobal(
            "fetch",
            vi.fn().mockResolvedValue({
                ok: true,
                arrayBuffer: vi.fn().mockResolvedValue(new Uint8Array(0).buffer)
            } as Partial<Response>)
        );
        try {
            await expect((cap as any).resolveVideoBase64({ uri: "https://example.com/v.mp4" })).resolves.toBeUndefined();
        } finally {
            vi.unstubAllGlobals();
        }

        await expect((cap as any).downloadViaFilesApi("files/abc123")).rejects.toThrow(
            "Gemini files.download failed for all attempted file reference formats"
        );
    });
});
