import { describe, expect, it, vi } from "vitest";
import { GenericJob, JobManager, MultiModalExecutionContext } from "#root/index.js";
import type { AIResponse } from "#root/core/types/AIResponse.js";

function makeJob(id?: string, output: unknown = "ok") {
    const job = new GenericJob({ input: 1 }, false, async () => ({ output }));
    if (id) {
        (job as any)._id = id;
    }
    return job;
}

describe("JobManager", () => {
    it("validates runtime limits", () => {
        const manager = new JobManager();
        expect(() => manager.setMaxConcurrency(-1 as any)).toThrow("maxConcurrency must be a non-negative integer");
        expect(() => manager.setMaxQueueSize(-1 as any)).toThrow("maxQueueSize must be a non-negative integer");
        expect(() => manager.setMaxStoredResponseChunks(-1 as any)).toThrow("maxStoredResponseChunks must be a non-negative integer");
        expect(() => manager.setStoreRawResponses("x" as any)).toThrow("storeRawResponses must be a boolean");
        expect(() => manager.setMaxRawBytesPerJob(-1 as any)).toThrow("maxRawBytesPerJob must be a non-negative integer");

        manager.setMaxConcurrency(2);
        manager.setMaxQueueSize(3);
        manager.setMaxStoredResponseChunks(4);
        manager.setStoreRawResponses(true);
        manager.setMaxRawBytesPerJob(5);

        expect(manager.getMaxConcurrency()).toBe(2);
        expect(manager.getMaxQueueSize()).toBe(3);
        expect(manager.getMaxStoredResponseChunks()).toBe(4);
        expect(manager.getStoreRawResponses()).toBe(true);
        expect(manager.getMaxRawBytesPerJob()).toBe(5);
    });

    it("adds jobs and rejects duplicate IDs", () => {
        const manager = new JobManager();
        const job = makeJob("j1");
        manager.addJob(job);
        expect(manager.getJob("j1")).toBe(job);
        expect(() => manager.addJob(job)).toThrow("JobManager: job 'j1' already exists");
    });

    it("runJob fails when execution disabled or queue full", () => {
        const disabled = new JobManager({ maxConcurrency: 0 });
        const jobA = makeJob("jA");
        disabled.addJob(jobA);
        expect(() => disabled.runJob("jA", new MultiModalExecutionContext())).toThrow("maxConcurrency is 0");

        const full = new JobManager({ maxQueueSize: 0 });
        const jobB = makeJob("jB");
        full.addJob(jobB);
        expect(() => full.runJob("jB", new MultiModalExecutionContext())).toThrow("queue is full");
    });

    it("runJob validates not-found, already-running, and already-queued cases", async () => {
        const manager = new JobManager({ maxConcurrency: 1 });

        expect(() => manager.runJob("missing", new MultiModalExecutionContext())).toThrow("job 'missing' not found");

        let releaseFirst: (() => void) | undefined;
        const first = new GenericJob(
            { input: 1 },
            false,
            async () =>
                new Promise<AIResponse<string>>((resolve) => {
                    releaseFirst = () => resolve({ output: "first" });
                })
        );
        (first as any)._id = "j1";

        const second = makeJob("j2");
        manager.addJob(first);
        manager.addJob(second);

        manager.runJob("j1", new MultiModalExecutionContext());
        expect(() => manager.runJob("j1", new MultiModalExecutionContext())).toThrow("job 'j1' is already running");

        manager.runJob("j2", new MultiModalExecutionContext());
        expect(() => manager.runJob("j2", new MultiModalExecutionContext())).toThrow("job 'j2' is already queued");

        releaseFirst?.();
        await first.getCompletionPromise();
        await second.getCompletionPromise();
    });

    it("runs jobs and triggers hooks", async () => {
        const hooks = {
            onStart: vi.fn(),
            onProgress: vi.fn(),
            onComplete: vi.fn(),
            onError: vi.fn()
        };
        const manager = new JobManager({ hooks });
        const job = new GenericJob(
            { input: 1 },
            true,
            async (_input, _ctx, _signal, onChunk) => {
                onChunk?.({ delta: "d" }, { delta: "d", done: false } as any);
                onChunk?.({ final: "f" }, { output: "f", done: true } as any);
                return { output: "f" };
            }
        );
        (job as any)._id = "j1";
        manager.addJob(job);
        manager.runJob("j1", new MultiModalExecutionContext());
        await job.getCompletionPromise();

        expect(hooks.onStart).toHaveBeenCalled();
        expect(hooks.onProgress).toHaveBeenCalled();
        expect(hooks.onComplete).toHaveBeenCalled();
        expect(hooks.onError).not.toHaveBeenCalled();
    });

    it("serializes queued jobs with maxConcurrency and updates running count", async () => {
        const manager = new JobManager({ maxConcurrency: 1 });
        const runOrder: string[] = [];

        let releaseFirst: (() => void) | undefined;
        const first = new GenericJob(
            { input: 1 },
            false,
            async () =>
                new Promise<AIResponse<string>>((resolve) => {
                    runOrder.push("first-start");
                    releaseFirst = () => resolve({ output: "first-done" });
                })
        );
        (first as any)._id = "j1";

        const second = new GenericJob({ input: 2 }, false, async () => {
            runOrder.push("second-start");
            return { output: "second-done" };
        });
        (second as any)._id = "j2";

        manager.addJob(first);
        manager.addJob(second);
        manager.runJob("j1", new MultiModalExecutionContext());
        manager.runJob("j2", new MultiModalExecutionContext());

        expect(manager.getRunningCount()).toBe(1);
        expect(manager.getQueueLength()).toBe(1);
        expect(runOrder).toEqual(["first-start"]);

        releaseFirst?.();
        await first.getCompletionPromise();
        await second.getCompletionPromise();
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(runOrder).toEqual(["first-start", "second-start"]);
        expect(manager.getRunningCount()).toBe(0);
        expect(manager.getQueueLength()).toBe(0);
    });

    it("reruns completed job", async () => {
        const manager = new JobManager();
        const job = makeJob("j2", "first");
        manager.addJob(job);
        manager.runJob("j2", new MultiModalExecutionContext());
        await job.getCompletionPromise();
        expect(job.status).toBe("completed");

        // swap executor output for rerun
        (job as any).executor = async () => ({ output: "second" });
        manager.rerunJob("j2", new MultiModalExecutionContext());
        await job.getCompletionPromise();
        expect(job.output).toBe("second");
    });

    it("rerunJob throws for missing and running jobs", async () => {
        const manager = new JobManager();
        expect(() => manager.rerunJob("missing", new MultiModalExecutionContext())).toThrow("job 'missing' not found");

        let release: (() => void) | undefined;
        const runningJob = new GenericJob(
            { input: 1 },
            false,
            async () =>
                new Promise<AIResponse<string>>((resolve) => {
                    release = () => resolve({ output: "done" });
                })
        );
        (runningJob as any)._id = "running";
        manager.addJob(runningJob);
        manager.runJob("running", new MultiModalExecutionContext());

        expect(() => manager.rerunJob("running", new MultiModalExecutionContext())).toThrow(
            "job 'running' is running and cannot be rerun"
        );

        release?.();
        await runningJob.getCompletionPromise();
    });

    it("abortJob marks status and notifies subscribers", () => {
        const manager = new JobManager();
        const job = makeJob("j3");
        manager.addJob(job);
        const updates: any[] = [];
        manager.subscribe("j3", (snap) => updates.push(snap.status));

        manager.abortJob("j3", "stop");
        expect(job.status).toBe("aborted");
        expect(job.error?.message).toBe("stop");
        expect(updates).toContain("aborted");
    });

    it("abortJob without reason marks job aborted with default error handling", () => {
        const manager = new JobManager();
        const job = makeJob("j3b");
        manager.addJob(job);

        manager.abortJob("j3b");
        expect(job.status).toBe("aborted");
    });

    it("abortJob aborts an actively running job controller", async () => {
        const manager = new JobManager();
        const job = new GenericJob(
            { input: 1 },
            false,
            async (_input, _ctx, signal) => {
                if (signal?.aborted) {
                    throw new Error("aborted");
                }

                await new Promise((resolve) => setTimeout(resolve, 5));
                if (signal?.aborted) {
                    throw new Error("aborted");
                }
                return { output: "ok" };
            }
        );
        (job as any)._id = "running-abort";
        manager.addJob(job);

        manager.runJob("running-abort", new MultiModalExecutionContext());
        manager.abortJob("running-abort", "stop now");

        await expect(job.getCompletionPromise()).rejects.toThrow();
        expect(job.status).toBe("aborted");
    });

    it("abortJob throws for unknown jobs", () => {
        const manager = new JobManager();
        expect(() => manager.abortJob("missing")).toThrow("job 'missing' not found");
    });

    it("subscribe immediately emits current snapshot and unsubscribe stops updates", () => {
        const manager = new JobManager();
        const job = makeJob("j-sub");
        manager.addJob(job);

        const statuses: string[] = [];
        const unsubscribe = manager.subscribe("j-sub", (snap) => statuses.push(snap.status));
        expect(statuses).toEqual(["pending"]);

        manager.abortJob("j-sub", "stop");
        expect(statuses).toContain("aborted");
        const afterAbort = statuses.length;

        unsubscribe();
        manager.rerunJob("j-sub", new MultiModalExecutionContext());
        expect(statuses).toHaveLength(afterAbort);
    });

    it("subscribe on unknown job does not emit immediately but emits once job exists", () => {
        const manager = new JobManager();
        const updates: string[] = [];
        manager.subscribe("later", (snap) => updates.push(snap.status));
        expect(updates).toEqual([]);

        const job = makeJob("later");
        manager.addJob(job);
        manager.abortJob("later", "stop");
        expect(updates).toContain("aborted");
    });

    it("subscribe reuses existing subscriber set when called repeatedly for same job", () => {
        const manager = new JobManager();
        const a = vi.fn();
        const b = vi.fn();

        manager.subscribe("same", a);
        manager.subscribe("same", b);

        const job = makeJob("same");
        manager.addJob(job);
        manager.abortJob("same", "x");

        expect(a).toHaveBeenCalled();
        expect(b).toHaveBeenCalled();
    });

    it("abortJob on running job without reason uses default abort reason path", async () => {
        const manager = new JobManager();
        const job = new GenericJob(
            { input: 1 },
            false,
            async (_input, _ctx, signal) => {
                if (signal?.aborted) {
                    throw signal.reason ?? new Error("aborted");
                }
                await new Promise((resolve) => setTimeout(resolve, 5));
                if (signal?.aborted) {
                    throw signal.reason ?? new Error("aborted");
                }
                return { output: "ok" };
            }
        );
        (job as any)._id = "running-abort-default";
        manager.addJob(job);

        manager.runJob("running-abort-default", new MultiModalExecutionContext());
        manager.abortJob("running-abort-default");

        await expect(job.getCompletionPromise()).rejects.toThrow();
        expect(job.status).toBe("aborted");
    });

    it("calls persistJobs hook on add and lifecycle changes", async () => {
        const persistJobs = vi.fn();
        const manager = new JobManager({ persistJobs });
        const job = makeJob("persist");
        manager.addJob(job);
        manager.runJob("persist", new MultiModalExecutionContext());
        await job.getCompletionPromise();

        expect(persistJobs).toHaveBeenCalled();
        expect(persistJobs.mock.calls.length).toBeGreaterThan(1);
        const snapshots = persistJobs.mock.calls[persistJobs.mock.calls.length - 1]?.[0];
        expect(Array.isArray(snapshots)).toBe(true);
    });

    it("restores persisted snapshots on construction", () => {
        const persisted = [
            {
                id: "p1",
                schemaVersion: 1,
                status: "completed",
                input: { input: 1 },
                output: "ok"
            }
        ];
        const manager = new JobManager({
            loadPersistedJobs: () => persisted as any
        });

        expect(manager.listJobs()).toHaveLength(1);
        expect(manager.getJob("p1")?.status).toBe("completed");
    });

    it("restores with fallback executor when no jobFactory is provided", async () => {
        const manager = new JobManager({
            loadPersistedJobs: () =>
                [
                    {
                        id: "restored-no-factory",
                        schemaVersion: 1,
                        status: "pending",
                        input: { input: 1 }
                    }
                ] as any
        });

        const job = manager.getJob("restored-no-factory");
        expect(job).toBeDefined();
        manager.runJob("restored-no-factory", new MultiModalExecutionContext());
        await expect(job!.getCompletionPromise()).rejects.toThrow("Restored job cannot be executed");
    });

    it("restores via provided jobFactory", async () => {
        const factory = vi.fn((snapshot: any) => {
            const job = new GenericJob(snapshot.input, false, async () => ({ output: "from-factory" }));
            (job as any)._id = snapshot.id;
            return job;
        });

        const manager = new JobManager({
            loadPersistedJobs: () =>
                [
                    {
                        id: "factory-job",
                        schemaVersion: 1,
                        status: "pending",
                        input: { input: 1 }
                    }
                ] as any,
            jobFactory: factory
        });

        expect(factory).toHaveBeenCalledTimes(1);
        manager.runJob("factory-job", new MultiModalExecutionContext());
        await expect(manager.getJob("factory-job")!.getCompletionPromise()).resolves.toBe("from-factory");
    });

    it("falls back to non-runnable restored job when jobFactory throws", async () => {
        const manager = new JobManager({
            loadPersistedJobs: () =>
                [
                    {
                        id: "factory-fallback",
                        schemaVersion: 1,
                        status: "pending",
                        input: { input: 1 }
                    }
                ] as any,
            jobFactory: () => {
                throw new Error("missing capability registration");
            }
        });

        const job = manager.getJob("factory-fallback");
        expect(job).toBeDefined();
        manager.runJob("factory-fallback", new MultiModalExecutionContext());
        await expect(job!.getCompletionPromise()).rejects.toThrow("cannot be executed: missing capability registration");
    });

    it("handles unexpected run promise rejection via guard catch", async () => {
        const hooks = {
            onStart: vi.fn(),
            onProgress: vi.fn(),
            onComplete: vi.fn(),
            onError: vi.fn()
        };
        const manager = new JobManager({ hooks });
        const job = makeJob("guard");

        (job as any).run = vi.fn().mockRejectedValue(new Error("run exploded"));
        (job as any).getCompletionPromise = () => new Promise(() => undefined);
        manager.addJob(job);

        manager.runJob("guard", new MultiModalExecutionContext());
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(hooks.onError).toHaveBeenCalled();
        expect(manager.getRunningCount()).toBe(0);
    });

    it("finalize guard prevents double-finalization and notifies safely for missing jobs", async () => {
        const hooks = {
            onStart: vi.fn(),
            onProgress: vi.fn(),
            onComplete: vi.fn(),
            onError: vi.fn()
        };
        const persistJobs = vi.fn();
        const manager = new JobManager({ hooks, persistJobs });
        const job = makeJob("double-finalize");

        (job as any).run = vi.fn().mockRejectedValue(new Error("run failed"));
        (job as any).getCompletionPromise = () => Promise.reject(new Error("completion failed"));
        manager.addJob(job);
        const persistBefore = persistJobs.mock.calls.length;

        manager.runJob("double-finalize", new MultiModalExecutionContext());
        await new Promise((resolve) => setTimeout(resolve, 0));
        await new Promise((resolve) => setTimeout(resolve, 0));

        const persistAfter = persistJobs.mock.calls.length;
        expect(persistAfter - persistBefore).toBeGreaterThanOrEqual(1);
        expect(persistAfter - persistBefore).toBeLessThan(4);

        (manager as any).notifySubscribers("missing-job-id");
    });

    it("throws on unsupported snapshot schema version", () => {
        expect(
            () =>
                new JobManager({
                    loadPersistedJobs: () => [{ id: "x", schemaVersion: 2, status: "pending", input: {} }] as any
                })
        ).toThrow("Unsupported JobSnapshot schemaVersion: 2");
    });
});
