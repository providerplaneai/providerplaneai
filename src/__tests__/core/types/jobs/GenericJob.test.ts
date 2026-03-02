import { describe, expect, it, vi } from "vitest";
import { GenericJob, MultiModalExecutionContext } from "#root/index.js";
import type { AIResponse } from "#root/core/types/AIResponse.js";

describe("GenericJob", () => {
    it("validates constructor limits", () => {
        expect(
            () =>
                new GenericJob(
                    { a: 1 },
                    false,
                    async () => ({ output: "x" }),
                    undefined,
                    -1
                )
        ).toThrow("GenericJob: maxStoredResponseChunks must be a non-negative integer");

        expect(
            () =>
                new GenericJob(
                    { a: 1 },
                    false,
                    async () => ({ output: "x" }),
                    undefined,
                    1,
                    { maxRawBytesPerJob: -1 }
                )
        ).toThrow("GenericJob: maxRawBytesPerJob must be a non-negative integer");
    });

    it("runs successfully and records output/response", async () => {
        const job = new GenericJob(
            { input: 1 },
            false,
            async () => ({ output: "done", metadata: { source: "test" } }),
            undefined,
            10
        );
        await job.run(new MultiModalExecutionContext());
        await expect(job.getCompletionPromise()).resolves.toBe("done");

        expect(job.isCompleted()).toBe(true);
        expect(job.output).toBe("done");
        expect(job.response?.metadata?.source).toBe("test");
    });

    it("calls lifecycle hooks and settles completion on executor error", async () => {
        const hooks = {
            onStart: vi.fn(),
            onComplete: vi.fn(),
            onError: vi.fn()
        };
        const err = new Error("executor failed");
        const job = new GenericJob(
            { input: 1 },
            false,
            async () => {
                throw err;
            },
            hooks
        );

        await job.run(new MultiModalExecutionContext());

        expect(job.isErrored()).toBe(true);
        expect(job.error).toBe(err);
        expect(hooks.onStart).toHaveBeenCalledTimes(1);
        expect(hooks.onComplete).not.toHaveBeenCalled();
        expect(hooks.onError).toHaveBeenCalledWith(err);
        await expect(job.getCompletionPromise()).rejects.toThrow("executor failed");
    });

    it("sets status to aborted when signal is aborted during failure", async () => {
        const controller = new AbortController();
        controller.abort();

        const job = new GenericJob(
            { input: 1 },
            false,
            async () => {
                throw new Error("cancelled");
            }
        );
        await job.run(new MultiModalExecutionContext(), controller.signal);
        await expect(job.getCompletionPromise()).rejects.toThrow("cancelled");

        expect(job.isAborted()).toBe(true);
    });

    it("does not rerun while already running", async () => {
        let resolveExec: ((value: AIResponse<string>) => void) | undefined;
        const executor = vi.fn(
            () =>
                new Promise<AIResponse<string>>((resolve) => {
                    resolveExec = resolve;
                })
        );
        const job = new GenericJob({ input: 1 }, false, executor);

        const ctx = new MultiModalExecutionContext();
        const firstRun = job.run(ctx);
        await Promise.resolve();
        await job.run(ctx);
        resolveExec?.({ output: "done" });
        await firstRun;

        expect(executor).toHaveBeenCalledTimes(1);
        expect(job.isCompleted()).toBe(true);
    });

    it("reports running status while executor is in-flight", async () => {
        let release: (() => void) | undefined;
        const job = new GenericJob(
            { input: 1 },
            false,
            async () =>
                new Promise<AIResponse<string>>((resolve) => {
                    release = () => resolve({ output: "ok" });
                })
        );

        const runPromise = job.run(new MultiModalExecutionContext());
        await Promise.resolve();
        expect(job.isRunning()).toBe(true);

        release?.();
        await runPromise;
        expect(job.isCompleted()).toBe(true);
    });

    it("captures streaming chunk state and completion metadata", async () => {
        const emitted: unknown[] = [];
        const job = new GenericJob(
            { input: 1 },
            true,
            async (_input, _ctx, _signal, onChunk) => {
                onChunk?.({ delta: "a" }, { delta: "a", done: false, raw: { c: 1 } } as any);
                onChunk?.({ final: "ab" }, { output: "ab", done: true, raw: { c: 2 } } as any);
                return { output: "ab", rawResponse: { c: 3 } };
            },
            undefined,
            10
        );
        await job.run(new MultiModalExecutionContext(), undefined, (chunk) => emitted.push(chunk));
        await expect(job.getCompletionPromise()).resolves.toBe("ab");

        expect(job.isCompleted()).toBe(true);
        expect(emitted).toEqual([{ delta: "a" }, { final: "ab" }]);
        expect(job.responseChunks).toHaveLength(2);
        expect(job.toSnapshot().streaming?.chunksEmitted).toBe(2);
        expect(job.toSnapshot().streaming?.completed).toBe(true);
    });

    it("trims stored chunks to maxStoredResponseChunks", async () => {
        const job = new GenericJob(
            { input: 1 },
            true,
            async (_input, _ctx, _signal, onChunk) => {
                onChunk?.({ delta: "a" }, { delta: "a", done: false } as any);
                onChunk?.({ delta: "b" }, { delta: "b", done: false } as any);
                onChunk?.({ final: "c" }, { output: "c", done: true } as any);
                return { output: "c" };
            },
            undefined,
            2
        );

        await job.run(new MultiModalExecutionContext());

        expect(job.responseChunks).toHaveLength(2);
        expect(job.responseChunks[0]).toMatchObject({ delta: "b" });
        expect(job.responseChunks[1]).toMatchObject({ output: "c" });
    });

    it("enforces raw byte budget and reports dropped payload metadata", async () => {
        const large = "x".repeat(50);
        const job = new GenericJob(
            { input: 1 },
            false,
            async (_input, _ctx, _signal, onChunk) => {
                onChunk?.({ delta: "a" }, { delta: "a", done: false, raw: large } as any);
                return { output: "ok", rawResponse: large };
            },
            undefined,
            10,
            { maxRawBytesPerJob: 10, storeRawResponses: true }
        );

        await job.run(new MultiModalExecutionContext());
        await expect(job.getCompletionPromise()).resolves.toBe("ok");

        expect(job.responseChunks[0].raw).toBeUndefined();
        expect(job.response?.rawResponse).toBeUndefined();
        expect(job.response?.metadata?.rawPayloadDropped).toBe(true);
        expect(job.response?.metadata?.rawPayloadDroppedCount).toBeGreaterThan(0);
    });

    it("omits chunk and final raw payloads when storeRawResponses is false", async () => {
        const job = new GenericJob(
            { input: 1 },
            true,
            async (_input, _ctx, _signal, onChunk) => {
                onChunk?.({ delta: "a" }, { delta: "a", done: false, raw: { c: 1 } } as any);
                return { output: "ok", rawResponse: { c: 2 } };
            },
            undefined,
            10,
            { storeRawResponses: false }
        );

        await job.run(new MultiModalExecutionContext());

        expect(job.responseChunks[0].raw).toBeUndefined();
        expect(job.response?.rawResponse).toBeUndefined();
        expect(job.response?.metadata?.rawPayloadDropped).toBe(false);
        expect(job.response?.metadata?.rawPayloadDroppedCount).toBe(0);
        expect(job.response?.metadata?.rawPayloadStoredBytes).toBe(0);
    });

    it("deduplicates artifacts by id while preserving entries without id", async () => {
        const job = new GenericJob(
            { input: 1 },
            true,
            async (_input, _ctx, _signal, onChunk) => {
                onChunk?.(
                    { delta: "a" },
                    {
                        delta: "a",
                        done: false,
                        multimodalArtifacts: {
                            custom: [{ id: "same", value: 1 }, { value: "no-id" }]
                        }
                    } as any
                );

                return {
                    output: "ok",
                    multimodalArtifacts: {
                        custom: [{ id: "same", value: 2 }, { id: "new", value: 3 }]
                    }
                };
            }
        );

        await job.run(new MultiModalExecutionContext());
        const custom = job.toSnapshot().multimodalArtifacts?.custom ?? [];

        expect(custom).toHaveLength(3);
        expect(custom[0]).toMatchObject({ id: "same", value: 1 });
        expect(custom[1]).toMatchObject({ value: "no-id" });
        expect(custom[2]).toMatchObject({ id: "new", value: 3 });
    });

    it("strips base64/data-url fields from snapshot output and artifacts when enabled", async () => {
        const artifact = {
            id: "v1",
            mimeType: "video/mp4",
            base64: "AAAA",
            url: "data:video/mp4;base64,AAAA"
        };

        const job = new GenericJob(
            { input: 1 },
            false,
            async () => ({
                output: [artifact] as any,
                multimodalArtifacts: { video: [artifact] as any }
            }),
            undefined,
            10,
            { stripBinaryPayloadsInSnapshotsAndTimeline: true }
        );

        await job.run(new MultiModalExecutionContext());
        const snap = job.toSnapshot() as any;
        const outVideo = snap.output?.[0];
        const artifactVideo = snap.multimodalArtifacts?.video?.[0];

        expect(outVideo.id).toBe("v1");
        expect(outVideo.base64).toBeUndefined();
        expect(outVideo.url).toBeUndefined();
        expect(artifactVideo.id).toBe("v1");
        expect(artifactVideo.base64).toBeUndefined();
        expect(artifactVideo.url).toBeUndefined();
    });

    it("handles raw byte estimation for supported and unsupported types", () => {
        const job = new GenericJob({ input: 1 }, false, async () => ({ output: "ok" }));
        const estimate = (job as any).estimateRawBytes.bind(job) as (value: unknown) => number | undefined;

        expect(estimate(Buffer.from("abc"))).toBe(3);
        expect(estimate(new Uint8Array([1, 2, 3]))).toBe(3);
        expect(estimate(new ArrayBuffer(4))).toBe(4);
        expect(estimate(123)).toBeGreaterThan(0);
        expect(estimate(false)).toBeGreaterThan(0);
        expect(estimate(1n)).toBeGreaterThan(0);

        const circular: Record<string, unknown> = {};
        circular.self = circular;
        expect(estimate(circular)).toBeUndefined();
        expect(estimate(Symbol("x"))).toBeUndefined();
    });

    it("resets and restores from snapshot correctly", async () => {
        const job = new GenericJob({ input: 1 }, false, async () => ({ output: "ok" }));
        await job.run(new MultiModalExecutionContext());
        const snap = job.toSnapshot();
        expect(job.isCompleted()).toBe(true);

        job.reset();
        expect(job.isPending()).toBe(true);
        expect(job.output).toBeUndefined();

        const runningSnap = { ...snap, status: "running" as const };
        job.restoreFromSnapshot(runningSnap as any);
        expect(job.status).toBe("interrupted");
    });

    it("rebuilds dedup state on restore and keeps dedup working", () => {
        const job = new GenericJob({ input: 1 }, false, async () => ({ output: "ok" }));
        job.restoreFromSnapshot({
            id: "j1",
            schemaVersion: 1,
            status: "completed",
            input: { input: 1 },
            multimodalArtifacts: {
                custom: [{ id: "same", value: 1 }]
            }
        } as any);

        const mergeArtifacts = (job as any).mergeArtifacts.bind(job) as (artifacts?: unknown) => void;
        mergeArtifacts({ custom: [{ id: "same", value: 2 }, { id: "new", value: 3 }] });

        const custom = job.toSnapshot().multimodalArtifacts?.custom ?? [];
        expect(custom).toHaveLength(2);
        expect(custom[0]).toMatchObject({ id: "same", value: 1 });
        expect(custom[1]).toMatchObject({ id: "new", value: 3 });
    });

    it("marks aborted and sets status helpers", () => {
        const job = new GenericJob({ input: 1 }, false, async () => ({ output: "ok" }));
        expect(job.isPending()).toBe(true);
        job.markAborted(new Error("stop"));
        expect(job.isAborted()).toBe(true);
        expect(job.error?.message).toBe("stop");
    });

    it("marks aborted without reason and keeps error unset", () => {
        const job = new GenericJob({ input: 1 }, false, async () => ({ output: "ok" }));
        job.markAborted();
        expect(job.isAborted()).toBe(true);
        expect(job.error).toBeUndefined();
    });
});
