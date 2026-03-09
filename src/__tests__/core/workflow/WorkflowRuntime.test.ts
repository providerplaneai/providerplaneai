import { describe, expect, it } from "vitest";
import { AIClient, GenericJob, JobManager, MultiModalExecutionContext, WorkflowBuilder, WorkflowRunner } from "#root/index.js";

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function createRunner(hooks?: ConstructorParameters<typeof WorkflowRunner>[0]["hooks"], persistence?: ConstructorParameters<typeof WorkflowRunner>[0]["persistence"]) {
    const jobManager = new JobManager();
    const client = {} as AIClient;
    return new WorkflowRunner({
        jobManager,
        client,
        hooks,
        persistence
    });
}

function createValueJob(value: string, delayMs: number = 0): GenericJob<void, string> {
    return new GenericJob<void, string>(undefined, false, async (_input, _ctx, signal) => {
        if (delayMs > 0) {
            await sleep(delayMs);
        }
        signal?.throwIfAborted();
        return {
            output: value,
            id: `job-${value}`,
            rawResponse: { value },
            metadata: {}
        };
    });
}

function createStreamingTextJob(parts: string[], delayMs: number = 5): GenericJob<void, string> {
    return new GenericJob<void, string>(undefined, true, async (_input, _ctx, signal, onChunk) => {
        for (const part of parts) {
            signal?.throwIfAborted();
            onChunk?.(
                { delta: part },
                {
                    id: `chunk-${part}`,
                    delta: part,
                    done: false
                }
            );
            if (delayMs > 0) {
                await sleep(delayMs);
            }
        }

        const output = parts.join("");
        onChunk?.(
            { final: output },
            {
                id: "chunk-final",
                output,
                done: true
            }
        );

        return {
            output,
            id: "stream-complete",
            rawResponse: { output },
            metadata: {}
        };
    });
}

function registerNodeJob<TInput, TOutput>(runner: WorkflowRunner, job: GenericJob<TInput, TOutput>): GenericJob<TInput, TOutput> {
    (runner as any).jobManager.addJob(job);
    return job;
}

describe("Workflow runtime integration (local deterministic)", () => {
    it("runs a streaming node and emits workflow chunk hooks", async () => {
        let chunkCount = 0;
        const runner = createRunner({
            onNodeChunk(_workflowId, _nodeId, chunk) {
                if (typeof chunk.delta === "string" && chunk.delta.length > 0) {
                    chunkCount += 1;
                }
            }
        });
        const ctx = new MultiModalExecutionContext();

        const workflow = new WorkflowBuilder<{ answer: string }>("workflow-local-streaming")
            .node("streamAsk", (_ctx, _client, runner) => registerNodeJob(runner, createStreamingTextJob(["alpha ", "beta ", "gamma"])))
            .aggregate((results) => ({
                answer: String(results.streamAsk ?? "")
            }))
            .build();

        const execution = await runner.run(workflow, ctx);
        expect(execution.status).toBe("completed");
        expect(chunkCount).toBeGreaterThan(0);
        expect(execution.output?.answer).toBe("alpha beta gamma");
    });

    it("runs nested workflows", async () => {
        const runner = createRunner();
        const ctx = new MultiModalExecutionContext();

        const childWorkflow = new WorkflowBuilder<{ childAnswer: string }>("workflow-local-child")
            .node("childA", (_ctx, _client, nestedRunner) => registerNodeJob(nestedRunner, createValueJob("nested")))
            .after("childA", "childB", (_ctx, _client, nestedRunner, state) =>
                registerNodeJob(nestedRunner, createValueJob(`${String(state.values.childA)}-ok`))
            )
            .aggregate((results) => ({
                childAnswer: String(results.childB ?? "")
            }))
            .build();

        const parentWorkflow = new WorkflowBuilder<{ nested: { childAnswer: string } }>("workflow-local-parent")
            .node("runChild", (_ctx, _c, nestedRunner) => nestedRunner.createWorkflowJob(childWorkflow))
            .aggregate((results) => ({
                nested: results.runChild as { childAnswer: string }
            }))
            .build();

        const execution = await runner.run(parentWorkflow, ctx);
        expect(execution.status).toBe("completed");
        expect(execution.output?.nested.childAnswer).toBe("nested-ok");
    });

    it("resumes from persisted snapshot after first run fails", async () => {
        const snapshots = new Map<string, any>();
        const runner = createRunner(
            undefined,
            {
                persistWorkflowExecution: async (snapshot) => {
                    snapshots.set(snapshot.workflowId, snapshot);
                },
                loadWorkflowExecution: async (workflowId) => snapshots.get(workflowId)
            }
        );
        const ctx = new MultiModalExecutionContext();

        let failStep2Once = true;
        const workflow = new WorkflowBuilder<{ step1: string; step2: string }>("workflow-local-resume")
            .node("step1", (_ctx, _client, nodeRunner) => registerNodeJob(nodeRunner, createValueJob("alpha")))
            .after("step1", "step2", (_ctx, _client, nodeRunner, state) => {
                if (failStep2Once) {
                    failStep2Once = false;
                    return registerNodeJob(
                        nodeRunner,
                        new GenericJob<void, string>(undefined, false, async () => {
                            throw new Error("intentional-step2-failure");
                        })
                    );
                }
                return registerNodeJob(nodeRunner, createValueJob(`${String(state.values.step1)}-beta`));
            })
            .aggregate((results) => ({
                step1: String(results.step1 ?? ""),
                step2: String(results.step2 ?? "")
            }))
            .build();

        await expect(runner.run(workflow, ctx)).rejects.toThrow("intentional-step2-failure");

        const snapshotAfterFailure = snapshots.get(workflow.id);
        expect(snapshotAfterFailure?.status).toBe("error");
        expect(snapshotAfterFailure?.completedNodeIds).toContain("step1");
        expect(snapshotAfterFailure?.completedNodeIds).not.toContain("step2");

        const resumed = await runner.resume(workflow, ctx);
        expect(resumed.status).toBe("completed");
        expect(resumed.output?.step1).toBe("alpha");
        expect(resumed.output?.step2).toBe("alpha-beta");
    });

    it("aborts an in-flight workflow run via AbortSignal", async () => {
        const runner = createRunner();
        const ctx = new MultiModalExecutionContext();
        const controller = new AbortController();

        const workflow = new WorkflowBuilder<{ value: string }>("workflow-local-abort")
            .node(
                "slow",
                (_ctx, _client, nodeRunner) =>
                    registerNodeJob(
                        nodeRunner,
                        new GenericJob<void, string>(undefined, false, async (_input, _ctx, signal) => {
                            for (let i = 0; i < 50; i++) {
                                signal?.throwIfAborted();
                                await sleep(10);
                            }
                            return {
                                output: "done",
                                id: "slow-done",
                                metadata: {}
                            };
                        })
                    )
            )
            .aggregate((results) => ({
                value: String(results.slow ?? "")
            }))
            .build();

        const runPromise = runner.run(workflow, ctx, undefined, controller.signal);
        setTimeout(() => controller.abort(), 30);

        await expect(runPromise).rejects.toThrow("Workflow aborted");
    });
});
