import { describe, expect, it, vi } from "vitest";
import { WorkflowBuilder } from "#root/core/workflow/WorkflowBuilder.js";
import { WorkflowRunner } from "#root/core/workflow/WorkflowRunner.js";

function makeRunner() {
    const jobManager = {
        runJob: vi.fn()
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
    it("runs sequential DAG nodes and propagates state", async () => {
        const { runner, jobManager, client } = makeRunner();
        const callOrder: string[] = [];

        const workflow = new WorkflowBuilder("wf-sequential")
            .node("a", (_ctx, c, _state) => {
                expect(c).toBe(client);
                callOrder.push("a");
                return makeJob("job-a", Promise.resolve("out-a"));
            })
            .after("a", "b", (_ctx, _c, state) => {
                expect(state.values.a).toBe("out-a");
                callOrder.push("b");
                return makeJob("job-b", Promise.resolve("out-b"));
            })
            .after("b", "c", (_ctx, _c, state) => {
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
            .after(["b", "c"], "d", (_ctx, _client, state) => {
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
        expect(jobManager.runJob).toHaveBeenCalledWith("job-a", expect.anything());

        // Resolving A unlocks B/C in the next scheduler pass.
        aDeferred.resolve("out-a");
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(jobManager.runJob).toHaveBeenCalledWith("job-b", expect.anything());
        expect(jobManager.runJob).toHaveBeenCalledWith("job-c", expect.anything());
        expect(dStarted).toBe(false);

        bDeferred.resolve("out-b");
        cDeferred.resolve("out-c");

        const execution = await runPromise;
        expect(dStarted).toBe(true);
        expect(execution.state.values.d).toBe("out-d");
        expect(jobManager.runJob).toHaveBeenCalledWith("job-d", expect.anything());
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
            .node("a", (_ctx, _client, state) => {
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
        const delaySpy = vi.spyOn(runner as any, "delay").mockResolvedValue(undefined);
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

        const execution = await runner.run(workflow, {} as any);
        expect(execution.status).toBe("completed");
        expect(execution.state.values.retrying).toBe("ok");
        expect(jobManager.runJob).toHaveBeenCalledTimes(3);
        expect(delaySpy).toHaveBeenCalledTimes(2);
        expect(delaySpy).toHaveBeenNthCalledWith(1, 25);
        expect(delaySpy).toHaveBeenNthCalledWith(2, 25);
    });

    it("fails node execution when timeoutMs is exceeded", async () => {
        const { runner, jobManager } = makeRunner();
        const never = new Promise<unknown>(() => undefined);

        const workflow = new WorkflowBuilder("wf-timeout")
            .node("slow", () => makeJob("job-slow", never), { timeoutMs: 5 })
            .build();

        await expect(runner.run(workflow, {} as any)).rejects.toThrow("exceeded timeout");
        expect(jobManager.runJob).toHaveBeenCalledTimes(1);
    });
});
