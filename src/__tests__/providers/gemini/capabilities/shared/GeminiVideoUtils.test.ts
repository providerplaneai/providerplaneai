import { writeFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { AIProvider, delayWithAbort } from "#root/index.js";

vi.mock("node:dns/promises", async () => {
    const actual = await vi.importActual<typeof import("node:dns/promises")>("node:dns/promises");
    return {
        ...actual,
        lookup: vi.fn().mockResolvedValue([{ address: "93.184.216.34", family: 4 }])
    };
});

import {
    DEFAULT_GEMINI_VIDEO_MAX_POLL_MS,
    DEFAULT_GEMINI_VIDEO_POLL_INTERVAL_MS,
    GEMINI_VIDEO_MAX_DURATION_SECONDS,
    GEMINI_VIDEO_MIN_DURATION_SECONDS,
    buildGeminiVideoArtifact,
    buildGeminiVideoResponseMetadata,
    ensureDurationInRange,
    extractGeminiFileName,
    extractGeneratedVideoOrThrow,
    pollGeminiVideoOperationUntilDone,
    readFiniteNumber,
    resolveGeminiDurationSeconds,
    resolveGeminiOperationId,
    resolveGeminiOperationResult,
    resolveGeminiPollingWindow,
    resolveGeminiVideoBase64,
    resolveGeminiVideoExecutionControls,
    downloadGeminiFileViaApi,
    throwIfGeminiOperationFailed
} from "#root/providers/gemini/capabilities/shared/GeminiVideoUtils.js";

describe("GeminiVideoUtils", () => {
    it("resolveGeminiPollingWindow and execution controls apply defaults and bounds", () => {
        const window = resolveGeminiPollingWindow({
            pollIntervalMs: 10,
            maxPollMs: 50,
            defaultPollIntervalMs: 2000,
            defaultMaxPollMs: 300000
        });
        expect(window.pollIntervalMs).toBe(250);
        expect(window.maxPollMs).toBe(250);

        const controls = resolveGeminiVideoExecutionControls();
        expect(controls.pollUntilComplete).toBe(true);
        expect(controls.includeBase64).toBe(false);
        expect(controls.pollIntervalMs).toBe(DEFAULT_GEMINI_VIDEO_POLL_INTERVAL_MS);
        expect(controls.maxPollMs).toBe(DEFAULT_GEMINI_VIDEO_MAX_POLL_MS);
    });

    it("delayWithAbort supports immediate resolve and abort rejection", async () => {
        await expect(delayWithAbort(0, undefined, "aborted")).resolves.toBeUndefined();

        const ac = new AbortController();
        ac.abort();
        await expect(delayWithAbort(10, ac.signal, "aborted")).rejects.toThrow("aborted");
    });

    it("pollGeminiVideoOperationUntilDone returns done operation, timeout, and abort paths", async () => {
        const client = {
            operations: {
                getVideosOperation: vi
                    .fn()
                    .mockResolvedValueOnce({ name: "op-1", done: false })
                    .mockResolvedValueOnce({ name: "op-1", done: true, response: { generatedVideos: [] } })
            }
        } as any;

        const done = await pollGeminiVideoOperationUntilDone({
            client,
            operation: { name: "op-1", done: false },
            pollIntervalMs: 1,
            maxPollMs: 1000,
            abortMessage: "aborted",
            timeoutMessage: (name) => `timeout ${name}`
        });
        expect(done.done).toBe(true);

        await expect(
            pollGeminiVideoOperationUntilDone({
                client,
                operation: { name: "op-2", done: false },
                pollIntervalMs: 1,
                maxPollMs: 0,
                abortMessage: "aborted",
                timeoutMessage: (name) => `timeout ${name}`
            })
        ).rejects.toThrow("timeout op-2");

        const ac = new AbortController();
        ac.abort();
        await expect(
            pollGeminiVideoOperationUntilDone({
                client,
                operation: { name: "op-3", done: false },
                pollIntervalMs: 1,
                maxPollMs: 1000,
                signal: ac.signal,
                abortMessage: "aborted",
                timeoutMessage: (name) => `timeout ${name}`
            })
        ).rejects.toThrow("aborted");
    });

    it("resolveGeminiOperationResult returns passthrough or polled result", async () => {
        const op = { name: "op-x", done: false };
        const client = { operations: { getVideosOperation: vi.fn().mockResolvedValue({ name: "op-x", done: true }) } } as any;

        const passthrough = await resolveGeminiOperationResult({
            client,
            operation: op,
            pollUntilComplete: false,
            pollIntervalMs: 1,
            maxPollMs: 1000,
            abortMessage: "aborted",
            timeoutMessage: (name) => `timeout ${name}`
        });
        expect(passthrough).toBe(op);

        const polled = await resolveGeminiOperationResult({
            client,
            operation: op,
            pollUntilComplete: true,
            pollIntervalMs: 1,
            maxPollMs: 1000,
            abortMessage: "aborted",
            timeoutMessage: (name) => `timeout ${name}`
        });
        expect(polled.done).toBe(true);
    });

    it("extractGeminiFileName parses direct refs and URLs", () => {
        expect(extractGeminiFileName("files/abc-123")).toBe("abc-123");
        expect(extractGeminiFileName("abc-123")).toBe("abc-123");
        expect(extractGeminiFileName("https://x/y?name=files%2Fabc-123")).toBe("abc-123");
        expect(extractGeminiFileName("https://x/v1beta/files/abc123:download")).toBe("abc123");
        expect(extractGeminiFileName("https://x/y/not-file")).toBeUndefined();
    });

    it("resolveGeminiVideoBase64 handles inline/data/http/fallback and failures", async () => {
        const client = {
            files: {
                download: vi.fn(async ({ downloadPath }: { downloadPath: string }) => {
                    await writeFile(downloadPath, Buffer.from([7, 8, 9]));
                })
            }
        } as any;

        expect(
            await resolveGeminiVideoBase64({
                client,
                video: { videoBytes: "AQID" },
                fetchFailureLabel: "fetch failed"
            })
        ).toBe("AQID");

        expect(
            await resolveGeminiVideoBase64({
                client,
                video: { uri: "data:video/mp4;base64,BAUG" },
                fetchFailureLabel: "fetch failed"
            })
        ).toBe("BAUG");

        vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
            ok: true,
            headers: { get: () => null },
            body: { getReader: () => { let done = false; return { read: async () => done ? { done: true, value: undefined } : (done = true, { done: false, value: Uint8Array.from([1, 2, 3]) }) }; } }
        } as Partial<Response>));
        try {
            expect(
                await resolveGeminiVideoBase64({
                    client,
                    video: { uri: "https://example/video.mp4" },
                    fetchFailureLabel: "fetch failed"
                })
            ).toBe("AQID");
        } finally {
            vi.unstubAllGlobals();
        }

        vi.stubGlobal(
            "fetch",
            vi.fn().mockResolvedValue({ ok: false, status: 403, statusText: "Forbidden" } as Partial<Response>)
        );
        try {
            expect(
                await resolveGeminiVideoBase64({
                    client,
                    video: { uri: "https://example/v1beta/files/abc123:download" },
                    fetchFailureLabel: "fetch failed"
                })
            ).toBe("BwgJ");
        } finally {
            vi.unstubAllGlobals();
        }

        vi.stubGlobal(
            "fetch",
            vi.fn().mockResolvedValue({ ok: false, status: 500, statusText: "Oops" } as Partial<Response>)
        );
        try {
            await expect(
                resolveGeminiVideoBase64({
                    client,
                    video: { uri: "https://example/video.mp4" },
                    fetchFailureLabel: "fetch failed"
                })
            ).rejects.toThrow("fetch failed: 500 Oops");
        } finally {
            vi.unstubAllGlobals();
        }
    });

    it("resolveGeminiVideoBase64 handles empty-uri and forbidden URL without mappable file id", async () => {
        const client = { files: { download: vi.fn() } } as any;
        expect(
            await resolveGeminiVideoBase64({
                client,
                video: {},
                fetchFailureLabel: "fetch failed"
            })
        ).toBeUndefined();

        vi.stubGlobal(
            "fetch",
            vi.fn().mockResolvedValue({ ok: false, status: 403, statusText: "Forbidden" } as Partial<Response>)
        );
        try {
            await expect(
                resolveGeminiVideoBase64({
                    client,
                    video: { uri: "https://example.com/not-a-file" },
                    fetchFailureLabel: "fetch failed"
                })
            ).rejects.toThrow("fetch failed: 403 Forbidden");
        } finally {
            vi.unstubAllGlobals();
        }
    });

    it("resolveGeminiVideoBase64 handles non-http file refs via Files API and empty downloaded bytes", async () => {
        const client = {
            files: {
                download: vi.fn(async ({ downloadPath }: { downloadPath: string }) => {
                    await writeFile(downloadPath, Buffer.alloc(0));
                })
            }
        } as any;

        const out = await resolveGeminiVideoBase64({
            client,
            video: { uri: "files/abc123" },
            fetchFailureLabel: "fetch failed"
        });
        expect(out).toBeUndefined();
    });

    it("downloadGeminiFileViaApi validates file names and handles non-Error retry failures", async () => {
        const client = {
            files: {
                download: vi.fn().mockRejectedValue("non-error rejection")
            }
        } as any;

        await expect(downloadGeminiFileViaApi(client, "files/invalid_name_")).rejects.toThrow(
            "Gemini video download requires a valid file reference"
        );
        await expect(downloadGeminiFileViaApi(client, "files/abc123")).rejects.toThrow(
            "Gemini files.download failed for all attempted file reference formats"
        );
    });

    it("downloadGeminiFileViaApi rethrows last Error rejection from retries", async () => {
        const client = {
            files: {
                download: vi
                    .fn()
                    .mockRejectedValueOnce(new Error("first error"))
                    .mockRejectedValueOnce(new Error("second error"))
            }
        } as any;

        await expect(downloadGeminiFileViaApi(client, "files/abc123")).rejects.toThrow("second error");
    });

    it("numeric and duration helpers handle parse/validation branches", () => {
        expect(readFiniteNumber(5)).toBe(5);
        expect(readFiniteNumber("7")).toBe(7);
        expect(readFiniteNumber("x")).toBeUndefined();
        expect(readFiniteNumber("   ")).toBeUndefined();

        expect(ensureDurationInRange(undefined, 4, 8)).toBeUndefined();
        expect(ensureDurationInRange(5, 4, 8)).toBe(5);
        expect(() => ensureDurationInRange(Number.NaN, 4, 8)).toThrow("finite number");
        expect(() => ensureDurationInRange(9, 4, 8)).toThrow("between 4 and 8");

        expect(resolveGeminiDurationSeconds(undefined, 4, 8)).toBeUndefined();
        expect(resolveGeminiDurationSeconds("5", 4, 8)).toBe(5);
        expect(resolveGeminiDurationSeconds("abc", 4, 8)).toBeUndefined();
        expect(() => resolveGeminiDurationSeconds(9, 4, 8)).toThrow("between 4 and 8");
    });

    it("operation and metadata helpers build expected normalized structures", () => {
        expect(resolveGeminiOperationId({ name: "op-1" })).toBe("op-1");
        expect(typeof resolveGeminiOperationId({})).toBe("string");

        expect(
            extractGeneratedVideoOrThrow(
                { response: { generatedVideos: [{ video: { uri: "u", mimeType: "video/mp4" } }] } },
                "missing video"
            )
        ).toEqual({ uri: "u", mimeType: "video/mp4" });
        expect(() => extractGeneratedVideoOrThrow({}, "missing video")).toThrow("missing video");

        expect(() => throwIfGeminiOperationFailed({}, "failed")).not.toThrow();
        expect(() => throwIfGeminiOperationFailed({ error: { code: 400 } }, "failed")).toThrow("failed:");

        const artifact = buildGeminiVideoArtifact({
            id: "v1",
            video: { uri: "https://example/video.mp4", mimeType: "video/mp4" },
            base64: "AQID",
            durationSeconds: 8,
            model: "veo",
            operationName: "op-1",
            done: true,
            requestId: "req-1"
        });
        expect(artifact.id).toBe("v1");
        expect(artifact.durationSeconds).toBe(8);
        expect((artifact.metadata as any).operationName).toBe("op-1");

        const meta = buildGeminiVideoResponseMetadata({
            contextMetadata: { source: "test" },
            model: "veo",
            operationName: "op-1",
            done: true,
            requestId: "req-1"
        });
        expect(meta).toMatchObject({
            source: "test",
            provider: AIProvider.Gemini,
            model: "veo",
            operationName: "op-1",
            done: true,
            requestId: "req-1"
        });
    });

    it("exports expected duration bounds constants", () => {
        expect(GEMINI_VIDEO_MIN_DURATION_SECONDS).toBe(4);
        expect(GEMINI_VIDEO_MAX_DURATION_SECONDS).toBe(8);
    });
});
