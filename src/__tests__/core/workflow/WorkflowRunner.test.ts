import { describe, expect, it, vi } from "vitest";
import { WorkflowBuilder } from "#root/core/workflow/WorkflowBuilder.js";
import { WorkflowRunner } from "#root/core/workflow/WorkflowRunner.js";
import { WORKFLOW_EXECUTION_SNAPSHOT_SCHEMA_VERSION } from "#root/index.js";

function makeRunner() {
    const jobManager = {
        runJob: vi.fn(),
        abortJob: vi.fn()
    } as any;
    const client = { marker: "client" } as any;
    const runner = new WorkflowRunner(jobManager, client);
    return { runner, jobManager, client };
}

function makeJob(id: string, completion: Promise<unknown>) {
    return {
        id,
        getCompletionPromise: vi.fn().mockReturnValue(completion)
    } as any;
}

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

describe("WorkflowRunner", () => {
    it("supports options-object constructor signature", async () => {
        const jobManager = { runJob: vi.fn(), abortJob: vi.fn() } as any;
        const client = {} as any;
        const onWorkflowStart = vi.fn();
        const runner = new WorkflowRunner({
            jobManager,
            client,
            hooks: { onWorkflowStart }
        });

        const workflow = new WorkflowBuilder("wf-options-ctor")
            .node("a", () => makeJob("job-a", Promise.resolve("a")))
            .build();

        const execution = await runner.run(workflow, {} as any);
        expect(execution.status).toBe("completed");
        expect(onWorkflowStart).toHaveBeenCalledWith("wf-options-ctor");
    });

    it("runs sequential DAG nodes and propagates state", async () => {
        const { runner, jobManager, client } = makeRunner();
        const callOrder: string[] = [];

        const workflow = new WorkflowBuilder("wf-sequential")
            .node("a", (_ctx, c, _state) => {
                expect(c).toBe(client);
                callOrder.push("a");
                return makeJob("job-a", Promise.resolve("out-a"));
            })
            .after("a", "b", (_ctx, _c, _runner, state) => {
                expect(state.values.a).toBe("out-a");
                callOrder.push("b");
                return makeJob("job-b", Promise.resolve("out-b"));
            })
            .after("b", "c", (_ctx, _c, _runner, state) => {
                expect(state.values.b).toBe("out-b");
                callOrder.push("c");
                return makeJob("job-c", Promise.resolve("out-c"));
            })
            .build();

        const execution = await runner.run(workflow, {} as any);

        expect(callOrder).toEqual(["a", "b", "c"]);
        expect(jobManager.runJob).toHaveBeenCalledTimes(3);
        expect(execution.status).toBe("completed");
        expect(execution.results.map((r) => r.stepId)).toEqual(["a", "b", "c"]);
        expect(execution.state.values).toMatchObject({ a: "out-a", b: "out-b", c: "out-c" });
    });

    it("runs parallel siblings and fan-in node after both dependencies complete", async () => {
        const { runner, jobManager } = makeRunner();
        const aDeferred = deferred<string>();
        const bDeferred = deferred<string>();
        const cDeferred = deferred<string>();
        let dStarted = false;

        const workflow = new WorkflowBuilder("wf-parallel")
            .node("a", () => makeJob("job-a", aDeferred.promise))
            .after("a", "b", () => makeJob("job-b", bDeferred.promise))
            .after("a", "c", () => makeJob("job-c", cDeferred.promise))
            .after(["b", "c"], "d", (_ctx, _client, _runner, state) => {
                dStarted = true;
                expect(state.values.b).toBe("out-b");
                expect(state.values.c).toBe("out-c");
                return makeJob("job-d", Promise.resolve("out-d"));
            })
            .build();

        const runPromise = runner.run(workflow, {} as any);

        // First batch only runs A.
        await Promise.resolve();
        expect(jobManager.runJob).toHaveBeenCalledTimes(1);
        expect(jobManager.runJob).toHaveBeenCalledWith("job-a", expect.anything(), expect.any(Function));

        // Resolving A unlocks B/C in the next scheduler pass.
        aDeferred.resolve("out-a");
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(jobManager.runJob).toHaveBeenCalledWith("job-b", expect.anything(), expect.any(Function));
        expect(jobManager.runJob).toHaveBeenCalledWith("job-c", expect.anything(), expect.any(Function));
        expect(dStarted).toBe(false);

        bDeferred.resolve("out-b");
        cDeferred.resolve("out-c");

        const execution = await runPromise;
        expect(dStarted).toBe(true);
        expect(execution.state.values.d).toBe("out-d");
        expect(jobManager.runJob).toHaveBeenCalledWith("job-d", expect.anything(), expect.any(Function));
    });

    it("retries node failures and succeeds before max attempts", async () => {
        const { runner, jobManager } = makeRunner();
        let attempt = 0;

        const workflow = new WorkflowBuilder("wf-retry-success")
            .node(
                "retrying",
                () => {
                    attempt += 1;
                    if (attempt === 1) {
                        return makeJob("job-r-1", Promise.reject(new Error("first failure")));
                    }
                    return makeJob("job-r-2", Promise.resolve("ok"));
                },
                { retry: { attempts: 2 } }
            )
            .build();

        const execution = await runner.run(workflow, {} as any);
        expect(execution.status).toBe("completed");
        expect(execution.state.values.retrying).toBe("ok");
        expect(jobManager.runJob).toHaveBeenCalledTimes(2);
        expect(execution.startedAt).toEqual(expect.any(Number));
        expect(execution.endedAt).toEqual(expect.any(Number));
        expect(execution.durationMs).toEqual(expect.any(Number));

        const step = execution.results.find((result) => result.stepId === "retrying");
        expect(step?.attemptCount).toBe(2);
        expect(step?.retryCount).toBe(1);
        expect(step?.totalAttemptDurationMs).toEqual(expect.any(Number));
        expect(step?.attempts?.map((attemptMetric) => attemptMetric.status)).toEqual(["error", "completed"]);
        expect(step?.attempts?.[0]?.errorMessage).toContain("first failure");
    });

    it("throws when retries are exhausted", async () => {
        const { runner, jobManager } = makeRunner();

        const workflow = new WorkflowBuilder("wf-retry-fail")
            .node(
                "retrying",
                (_ctx, _client, _state) => makeJob(`job-r-${crypto.randomUUID()}`, Promise.reject(new Error("still failing"))),
                { retry: { attempts: 2 } }
            )
            .build();

        await expect(runner.run(workflow, {} as any)).rejects.toThrow("still failing");
        expect(jobManager.runJob).toHaveBeenCalledTimes(2);
    });

    it("throws on unknown dependency", async () => {
        const { runner } = makeRunner();
        const workflow = {
            id: "wf-unknown-dep",
            nodes: [
                {
                    id: "a",
                    dependsOn: ["missing"],
                    run: () => makeJob("job-a", Promise.resolve("a"))
                }
            ]
        } as any;

        await expect(runner.run(workflow, {} as any)).rejects.toThrow("depends on unknown node 'missing'");
    });

    it("throws on dependency cycle", async () => {
        const { runner } = makeRunner();
        const workflow = {
            id: "wf-cycle",
            nodes: [
                {
                    id: "a",
                    dependsOn: ["b"],
                    run: () => makeJob("job-a", Promise.resolve("a"))
                },
                {
                    id: "b",
                    dependsOn: ["a"],
                    run: () => makeJob("job-b", Promise.resolve("b"))
                }
            ]
        } as any;

        await expect(runner.run(workflow, {} as any)).rejects.toThrow("cycle detected");
    });

    it("applies aggregate over results and shared state", async () => {
        const { runner } = makeRunner();

        const workflow = new WorkflowBuilder<{ summary: string }>("wf-aggregate")
            .node("a", (_ctx, _client, _runner, state) => {
                state.values.extra = "state";
                return makeJob("job-a", Promise.resolve("first"));
            })
            .after("a", "b", () => makeJob("job-b", Promise.resolve("second")))
            .aggregate((results, state) => ({
                summary: `${String(results.a)}|${String(results.b)}|${String(state.values.extra)}`
            }))
            .build();

        const execution = await runner.run(workflow, {} as any);
        expect(execution.output).toEqual({ summary: "first|second|state" });
    });

    it("skips nodes when condition evaluates to false", async () => {
        const { runner, jobManager } = makeRunner();
        const runSkippedNode = vi.fn();

        const workflow = {
            id: "wf-condition-skip",
            nodes: [
                {
                    id: "a",
                    run: () => makeJob("job-a", Promise.resolve("out-a"))
                },
                {
                    id: "b",
                    dependsOn: ["a"],
                    condition: () => false,
                    run: runSkippedNode
                }
            ]
        } as any;

        const execution = await runner.run(workflow, {} as any);

        expect(runSkippedNode).not.toHaveBeenCalled();
        expect(jobManager.runJob).toHaveBeenCalledTimes(1);
        const skipped = execution.results.find((r) => r.stepId === "b");
        expect(skipped?.skipped).toBe(true);
        expect(skipped?.jobIds).toEqual([]);
    });

    it("fires hooks in expected order for successful workflows", async () => {
        const jobManager = { runJob: vi.fn() } as any;
        const client = {} as any;
        const events: string[] = [];
        const runner = new WorkflowRunner(jobManager, client, {
            onWorkflowStart: (id) => events.push(`wf:start:${id}`),
            onNodeStart: (_wf, node) => events.push(`node:start:${node}`),
            onNodeComplete: (_wf, node) => events.push(`node:done:${node}`),
            onWorkflowComplete: (id) => events.push(`wf:done:${id}`)
        });

        const workflow = new WorkflowBuilder("wf-hooks")
            .node("a", () => makeJob("job-a", Promise.resolve("a")))
            .after("a", "b", () => makeJob("job-b", Promise.resolve("b")))
            .build();

        await runner.run(workflow, {} as any);

        expect(events[0]).toBe("wf:start:wf-hooks");
        expect(events).toContain("node:start:a");
        expect(events).toContain("node:done:a");
        expect(events).toContain("node:start:b");
        expect(events).toContain("node:done:b");
        expect(events.at(-1)).toBe("wf:done:wf-hooks");
    });

    it("fires onWorkflowError hook when workflow execution fails", async () => {
        const jobManager = { runJob: vi.fn() } as any;
        const client = {} as any;
        const onWorkflowError = vi.fn();
        const onWorkflowComplete = vi.fn();
        const runner = new WorkflowRunner(jobManager, client, {
            onWorkflowError,
            onWorkflowComplete
        });

        const workflow = new WorkflowBuilder("wf-error-hook")
            .node("a", () => makeJob("job-a", Promise.reject(new Error("boom"))))
            .build();

        await expect(runner.run(workflow, {} as any)).rejects.toThrow("boom");

        expect(onWorkflowError).toHaveBeenCalledTimes(1);
        expect(onWorkflowError.mock.calls[0]?.[0]).toBe("wf-error-hook");
        expect(onWorkflowError.mock.calls[0]?.[1]).toBeInstanceOf(Error);
        expect(onWorkflowError.mock.calls[0]?.[2]?.status).toBe("error");
        expect(onWorkflowComplete).not.toHaveBeenCalled();
    });

    it("awaits retry backoff delay between attempts", async () => {
        const { runner, jobManager } = makeRunner();
        let attempt = 0;

        const workflow = new WorkflowBuilder("wf-retry-backoff")
            .node(
                "retrying",
                () => {
                    attempt += 1;
                    if (attempt < 3) {
                        return makeJob(`job-r-${attempt}`, Promise.reject(new Error(`fail-${attempt}`)));
                    }
                    return makeJob("job-r-3", Promise.resolve("ok"));
                },
                { retry: { attempts: 3, backoffMs: 25 } }
            )
            .build();

        const start = Date.now();
        const execution = await runner.run(workflow, {} as any);
        const elapsed = Date.now() - start;

        expect(execution.status).toBe("completed");
        expect(execution.state.values.retrying).toBe("ok");
        expect(jobManager.runJob).toHaveBeenCalledTimes(3);
        // Two backoff delays of 25ms each should produce at least 40ms total elapsed time.
        expect(elapsed).toBeGreaterThanOrEqual(40);
    });

    it("fails node execution when timeoutMs is exceeded", async () => {
        const { runner, jobManager } = makeRunner();
        const never = new Promise<unknown>(() => undefined);

        const workflow = new WorkflowBuilder("wf-timeout")
            .node("slow", () => makeJob("job-slow", never), { timeoutMs: 5 })
            .build();

        await expect(runner.run(workflow, {} as any)).rejects.toThrow("exceeded timeout");
        expect(jobManager.runJob).toHaveBeenCalledTimes(1);
        expect(jobManager.abortJob).toHaveBeenCalledWith("job-slow", "Workflow node timed out");
    });

    it("applies workflow default retry policy when node retry is not set", async () => {
        const { runner, jobManager } = makeRunner();
        let attempt = 0;

        const workflow = {
            id: "wf-default-retry",
            defaults: { retry: { attempts: 2, backoffMs: 0 } },
            nodes: [
                {
                    id: "unstable",
                    run: () => {
                        attempt += 1;
                        if (attempt === 1) {
                            return makeJob("job-default-retry-1", Promise.reject(new Error("first-fail")));
                        }
                        return makeJob("job-default-retry-2", Promise.resolve("ok"));
                    }
                }
            ]
        } as any;

        const execution = await runner.run(workflow, {} as any);
        expect(execution.status).toBe("completed");
        expect(execution.state.values.unstable).toBe("ok");
        expect(jobManager.runJob).toHaveBeenCalledTimes(2);
    });

    it("applies workflow default timeout when node timeout is not set", async () => {
        const { runner, jobManager } = makeRunner();
        const never = new Promise<unknown>(() => undefined);

        const workflow = {
            id: "wf-default-timeout",
            defaults: { timeoutMs: 5 },
            nodes: [
                {
                    id: "slow",
                    run: () => makeJob("job-default-timeout", never)
                }
            ]
        } as any;

        await expect(runner.run(workflow, {} as any)).rejects.toThrow("exceeded timeout");
        expect(jobManager.abortJob).toHaveBeenCalledWith("job-default-timeout", "Workflow node timed out");
    });

    it("persists workflow snapshots during execution and completion", async () => {
        const { jobManager, client } = makeRunner();
        const persistWorkflowExecution = vi.fn();
        const runner = new WorkflowRunner(jobManager, client, undefined, {
            persistWorkflowExecution
        });

        const workflow = new WorkflowBuilder("wf-persist")
            .version("v1")
            .node("a", () => makeJob("job-a", Promise.resolve("out-a")))
            .after("a", "b", () => makeJob("job-b", Promise.resolve("out-b")))
            .build();

        await runner.run(workflow, {} as any);

        expect(persistWorkflowExecution).toHaveBeenCalled();
        const snapshots = persistWorkflowExecution.mock.calls.map((c) => c[0]);
        expect(snapshots.some((s) => s.status === "running")).toBe(true);
        expect(snapshots.some((s) => s.status === "completed")).toBe(true);
        const last = snapshots.at(-1);
        expect(last.workflowId).toBe("wf-persist");
        expect(last.workflowVersion).toBe("v1");
        expect(last.schemaVersion).toBe(WORKFLOW_EXECUTION_SNAPSHOT_SCHEMA_VERSION);
        expect(last.completedNodeIds.sort()).toEqual(["a", "b"]);
    });

    it("resumes from persisted snapshot and only executes remaining nodes", async () => {
        const { jobManager, client } = makeRunner();
        const persisted = {
            schemaVersion: WORKFLOW_EXECUTION_SNAPSHOT_SCHEMA_VERSION,
            workflowId: "wf-resume",
            workflowVersion: "v1",
            status: "running",
            completedNodeIds: ["a"],
            results: [
                {
                    stepId: "a",
                    jobIds: ["job-a"],
                    outputs: ["out-a"],
                    startedAt: Date.now() - 1000,
                    endedAt: Date.now() - 900,
                    durationMs: 100
                }
            ],
            state: { values: { a: "out-a" } },
            startedAt: Date.now() - 1000,
            updatedAt: Date.now() - 900
        };
        const runner = new WorkflowRunner(jobManager, client, undefined, {
            loadWorkflowExecution: vi.fn().mockResolvedValue(persisted),
            persistWorkflowExecution: vi.fn()
        });

        const workflow = new WorkflowBuilder("wf-resume")
            .version("v1")
            .node("a", () => makeJob("job-a-should-not-run", Promise.resolve("bad")))
            .after("a", "b", (_ctx, _c, _runner, state) => {
                expect(state.values.a).toBe("out-a");
                return makeJob("job-b", Promise.resolve("out-b"));
            })
            .build();

        const execution = await runner.resume(workflow, {} as any);
        expect(execution.status).toBe("completed");
        expect(execution.state.values.a).toBe("out-a");
        expect(execution.state.values.b).toBe("out-b");
        expect(jobManager.runJob).toHaveBeenCalledTimes(1);
        expect(jobManager.runJob).toHaveBeenCalledWith("job-b", expect.anything(), expect.any(Function));
    });

    it("rejects resume when snapshot schemaVersion is unsupported", async () => {
        const { jobManager, client } = makeRunner();
        const runner = new WorkflowRunner(jobManager, client, undefined, {
            loadWorkflowExecution: vi.fn().mockResolvedValue({
                schemaVersion: 999,
                workflowId: "wf-resume-bad-version",
                status: "running",
                completedNodeIds: [],
                results: [],
                state: { values: {} },
                startedAt: Date.now() - 1000,
                updatedAt: Date.now()
            })
        });

        const workflow = new WorkflowBuilder("wf-resume-bad-version")
            .node("a", () => makeJob("job-a", Promise.resolve("a")))
            .build();

        await expect(runner.resume(workflow, {} as any)).rejects.toThrow("unsupported workflow snapshot schemaVersion");
    });

    it("rejects resume when snapshot workflowVersion differs", async () => {
        const { jobManager, client } = makeRunner();
        const runner = new WorkflowRunner(jobManager, client, undefined, {
            loadWorkflowExecution: vi.fn().mockResolvedValue({
                schemaVersion: WORKFLOW_EXECUTION_SNAPSHOT_SCHEMA_VERSION,
                workflowId: "wf-resume-version",
                workflowVersion: "v1",
                status: "running",
                completedNodeIds: [],
                results: [],
                state: { values: {} },
                startedAt: Date.now() - 1000,
                updatedAt: Date.now()
            })
        });

        const workflow = new WorkflowBuilder("wf-resume-version")
            .version("v2")
            .node("a", () => makeJob("job-a", Promise.resolve("a")))
            .build();

        await expect(runner.resume(workflow, {} as any)).rejects.toThrow("snapshot workflowVersion");
    });

    it("rejects resume snapshot when completed node is missing a completed dependency", async () => {
        const { jobManager, client } = makeRunner();
        const runner = new WorkflowRunner(jobManager, client, undefined, {
            loadWorkflowExecution: vi.fn().mockResolvedValue({
                schemaVersion: WORKFLOW_EXECUTION_SNAPSHOT_SCHEMA_VERSION,
                workflowId: "wf-resume-deps",
                status: "running",
                completedNodeIds: ["b"],
                results: [
                    {
                        stepId: "b",
                        jobIds: ["job-b"],
                        outputs: ["out-b"]
                    }
                ],
                state: { values: { b: "out-b" } },
                startedAt: Date.now() - 1000,
                updatedAt: Date.now()
            })
        });

        const workflow = new WorkflowBuilder("wf-resume-deps")
            .node("a", () => makeJob("job-a", Promise.resolve("a")))
            .after("a", "b", () => makeJob("job-b", Promise.resolve("b")))
            .build();

        await expect(runner.resume(workflow, {} as any)).rejects.toThrow("missing completed dependency");
    });

    it("aborts nested child node job when parent workflow signal is aborted", async () => {
        const jobs = new Map<string, any>();
        const childDeferred = deferred<unknown>();
        const jobManager = {
            addJob: vi.fn((job: any) => {
                jobs.set(job.id, job);
            }),
            runJob: vi.fn((id: string, ctx: any, onChunk?: (chunk: any) => void) => {
                const registered = jobs.get(id);
                if (registered?.run) {
                    void registered.run(ctx, undefined, onChunk);
                }
                return registered;
            }),
            abortJob: vi.fn((_id: string) => {
                childDeferred.reject(new Error("Workflow aborted"));
            })
        } as any;

        const runner = new WorkflowRunner(jobManager, {} as any);
        const childWorkflow = new WorkflowBuilder("child-abort")
            .node("childSlow", () => makeJob("job-child-never", childDeferred.promise))
            .build();
        const parentWorkflow = new WorkflowBuilder("parent-abort")
            .node("nested", (_ctx, _c, runner) => runner.createWorkflowJob(childWorkflow))
            .build();

        const controller = new AbortController();
        const runPromise = runner.run(parentWorkflow, {} as any, undefined, controller.signal);
        await new Promise((resolve) => setTimeout(resolve, 0));
        controller.abort();

        await expect(runPromise).rejects.toThrow("Workflow aborted");
        expect(jobManager.abortJob).toHaveBeenCalled();
    });

    it("aborts an in-flight node job when workflow signal is aborted", async () => {
        const { runner, jobManager } = makeRunner();
        const slowDeferred = deferred<string>();
        const controller = new AbortController();
        jobManager.abortJob.mockImplementation((_id: string) => {
            slowDeferred.reject(new Error("Workflow aborted"));
        });

        const workflow = new WorkflowBuilder("wf-abort-single")
            .node("slow", () => makeJob("job-slow-abort", slowDeferred.promise))
            .build();

        const runPromise = runner.run(workflow, {} as any, undefined, controller.signal);
        await new Promise((resolve) => setTimeout(resolve, 0));
        controller.abort();

        await expect(runPromise).rejects.toThrow("Workflow aborted");
        expect(jobManager.abortJob).toHaveBeenCalledWith("job-slow-abort", "Workflow aborted");
    });

    it("aborts all in-flight parallel node jobs when workflow signal is aborted", async () => {
        const { runner, jobManager } = makeRunner();
        const aDeferred = deferred<string>();
        const bDeferred = deferred<string>();
        const cDeferred = deferred<string>();
        const controller = new AbortController();
        jobManager.abortJob.mockImplementation((id: string) => {
            if (id === "job-a-abort") {
                aDeferred.reject(new Error("Workflow aborted"));
            } else if (id === "job-b-abort") {
                bDeferred.reject(new Error("Workflow aborted"));
            } else if (id === "job-c-abort") {
                cDeferred.reject(new Error("Workflow aborted"));
            }
        });

        const workflow = new WorkflowBuilder("wf-abort-parallel")
            .node("a", () => makeJob("job-a-abort", aDeferred.promise))
            .after("a", "b", () => makeJob("job-b-abort", bDeferred.promise))
            .after("a", "c", () => makeJob("job-c-abort", cDeferred.promise))
            .build();

        const runPromise = runner.run(workflow, {} as any, undefined, controller.signal);
        await new Promise((resolve) => setTimeout(resolve, 0));
        aDeferred.resolve("out-a");
        await new Promise((resolve) => setTimeout(resolve, 0));

        controller.abort();

        await expect(runPromise).rejects.toThrow("Workflow aborted");
        expect(jobManager.abortJob).toHaveBeenCalledWith("job-b-abort", "Workflow aborted");
        expect(jobManager.abortJob).toHaveBeenCalledWith("job-c-abort", "Workflow aborted");
    });

    it("covers executeNode abort and impossible-fallback error branches directly", async () => {
        const { runner } = makeRunner();
        const controller = new AbortController();
        controller.abort();

        await expect(
            (runner as any).runNodeWithRetry(
                "wf-direct-abort",
                { id: "node-a", run: vi.fn() },
                {} as any,
                { values: {} },
                new Set<string>(),
                undefined,
                controller.signal
            )
        ).rejects.toThrow("Workflow aborted");

        await expect(
            (runner as any).runNodeWithRetry(
                "wf-direct-fallback",
                { id: "node-b", run: vi.fn(), retry: { attempts: Number.NaN } },
                {} as any,
                { values: {} },
                new Set<string>()
            )
        ).rejects.toThrow("failed unexpectedly without error");
    });

    it("covers duplicate workflow ids and missing-node cycle helper branch", async () => {
        const { runner } = makeRunner();
        const duplicateWorkflow = {
            id: "wf-duplicate",
            nodes: [
                { id: "a", run: () => makeJob("job-a", Promise.resolve("a")) },
                { id: "a", run: () => makeJob("job-b", Promise.resolve("b")) }
            ]
        } as any;

        await expect(runner.run(duplicateWorkflow, {} as any)).rejects.toThrow("duplicate node id 'a'");

        expect(() =>
            (runner as any).validateNoCycles({
                nodes: [{ id: "a", dependsOn: ["missing"] }]
            })
        ).not.toThrow();
    });
});
