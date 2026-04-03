import { describe, expect, it, vi } from "vitest";
import { delayWithAbort } from "#root/index.js";
import {
    downloadGeminiFileViaApi,
    extractGeminiFileName,
    readFiniteNumber,
    resolveGeminiDurationSeconds,
    resolveGeminiVideoBase64
} from "#root/providers/gemini/capabilities/shared/GeminiVideoUtils.js";
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

    it("shared helpers cover duration parsing, finite-number parsing, filename extraction, and delay branches", async () => {
        expect(readFiniteNumber(5)).toBe(5);
        expect(readFiniteNumber("6")).toBe(6);
        expect(readFiniteNumber("abc")).toBeUndefined();
        expect(readFiniteNumber(undefined)).toBeUndefined();

        expect(resolveGeminiDurationSeconds(undefined, 4, 8)).toBeUndefined();
        expect(resolveGeminiDurationSeconds(5, 4, 8)).toBe(5);
        expect(() => resolveGeminiDurationSeconds(Number.NaN, 4, 8)).toThrow("finite number");
        expect(() => resolveGeminiDurationSeconds(9, 4, 8)).toThrow("between 4 and 8");

        expect(extractGeminiFileName("files/abc-123")).toBe("abc-123");
        expect(extractGeminiFileName("https://x/v1beta/files/abc123:download")).toBe("abc123");
        expect(extractGeminiFileName("https://x/?name=files%2Fabc123")).toBe("abc123");
        expect(extractGeminiFileName("https://x/not-file")).toBeUndefined();

        await expect(delayWithAbort(0, undefined, "Gemini video extension polling aborted")).resolves.toBeUndefined();
        const ac = new AbortController();
        ac.abort();
        await expect(delayWithAbort(5, ac.signal, "Gemini video extension polling aborted")).rejects.toThrow(
            "polling aborted"
        );
    });

    it("resolveVideoBase64 covers data-uri/http-success/http-failure/non-http branches", async () => {
        const client = { models: {}, operations: {} } as any;

        await expect(
            resolveGeminiVideoBase64({ client, video: { videoBytes: "AQID" }, fetchFailureLabel: "Failed to fetch extended video from URI" })
        ).resolves.toBe("AQID");
        await expect(
            resolveGeminiVideoBase64({ client, video: { uri: "data:video/mp4;base64,BAUG" }, fetchFailureLabel: "Failed to fetch extended video from URI" })
        ).resolves.toBe("BAUG");

        vi.stubGlobal(
            "fetch",
            vi.fn().mockResolvedValue({
                ok: true,
                headers: { get: () => null },
                body: { getReader: () => { let done = false; return { read: async () => done ? { done: true, value: undefined } : (done = true, { done: false, value: Uint8Array.from([1, 2]) }) }; } }
            } as Partial<Response>)
        );
        await expect(
            resolveGeminiVideoBase64({ client, video: { uri: "https://example.com/v.mp4" }, fetchFailureLabel: "Failed to fetch extended video from URI" })
        ).resolves.toBe("AQI=");

        vi.stubGlobal(
            "fetch",
            vi.fn().mockResolvedValue({ ok: false, status: 500, statusText: "Server Error" } as Partial<Response>)
        );
        await expect(
            resolveGeminiVideoBase64({ client, video: { uri: "https://example.com/v.mp4" }, fetchFailureLabel: "Failed to fetch extended video from URI" })
        ).rejects.toThrow(
            "Failed to fetch extended video from URI: 500 Server Error"
        );

        vi.unstubAllGlobals();
        await expect(
            resolveGeminiVideoBase64({ client, video: { uri: "files/invalid_name_" }, fetchFailureLabel: "Failed to fetch extended video from URI" })
        ).rejects.toThrow(
            "Gemini video download requires a valid file reference"
        );
    });

    it("downloadViaFilesApi retries refs and surfaces last failure", async () => {
        const download = vi
            .fn()
            .mockRejectedValueOnce(new Error("first failed"))
            .mockRejectedValueOnce(new Error("second failed"));
        const client = {
            models: {},
            operations: {},
            files: { download }
        } as any;

        await expect(downloadGeminiFileViaApi(client, "files/abc123")).rejects.toThrow("second failed");
    });

    it("covers empty fetch bytes and generic files API failure", async () => {
        const client = {
            models: {},
            operations: { getVideosOperation: vi.fn().mockResolvedValue({ done: false, name: "op-timeout" }) },
            files: { download: vi.fn().mockRejectedValue("non-error failure") }
        } as any;

        vi.stubGlobal(
            "fetch",
            vi.fn().mockResolvedValue({
                ok: true,
                headers: { get: () => null },
                body: { getReader: () => ({ read: async () => ({ done: true, value: undefined }) }) }
            } as Partial<Response>)
        );
        try {
            await expect(
                resolveGeminiVideoBase64({ client, video: { uri: "https://example.com/v.mp4" }, fetchFailureLabel: "Failed to fetch extended video from URI" })
            ).resolves.toBeUndefined();
        } finally {
            vi.unstubAllGlobals();
        }

        await expect(downloadGeminiFileViaApi(client, "files/abc123")).rejects.toThrow(
            "Gemini files.download failed for all attempted file reference formats"
        );
    });

    it(
        "surfaces the capability-specific timeout message when extension polling never reaches done",
        async () => {
            const provider = makeProvider();
            provider.getMergedOptions = vi.fn().mockReturnValue({
                model: "veo-extend",
                modelParams: undefined,
                providerParams: undefined,
                generalParams: { pollIntervalMs: 1, maxPollMs: 5 }
            });

            const client = {
                models: { generateVideos: vi.fn().mockResolvedValue({ done: false, name: "operations/ge-timeout" }) },
                operations: { getVideosOperation: vi.fn().mockResolvedValue({ done: false, name: "operations/ge-timeout" }) }
            };
            const cap = new GeminiVideoExtendCapabilityImpl(provider, client as any);

            await expect(
                cap.extendVideo({
                    input: {
                        sourceVideoUri: "gs://bucket/input.mp4"
                    }
                } as any)
            ).rejects.toThrow("Timed out waiting for Gemini video operation 'operations/ge-timeout'");
        },
        1000
    );
});
