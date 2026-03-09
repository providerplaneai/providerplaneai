import { describe, expect, it } from "vitest";
import { GenericJob, JobManager, MultiModalExecutionContext, WorkflowBuilder, WorkflowRunner } from "#root/index.js";

function createHarness(hooks?: ConstructorParameters<typeof WorkflowRunner>[0]["hooks"]) {
    const jobManager = new JobManager();
    const runner = new WorkflowRunner({
        jobManager,
        client: {} as any,
        hooks
    });
    const ctx = new MultiModalExecutionContext();

    function queueJob<TOutput>(
        executor: (onChunk?: (chunk: any, internalChunk?: any) => void) => Promise<TOutput>,
        streaming = false
    ) {
        const job = new GenericJob<void, TOutput>(undefined, streaming, async (_input, _ctx, _signal, onChunk) => ({
            output: await executor(onChunk),
            id: crypto.randomUUID(),
            metadata: { status: "completed" }
        }));
        jobManager.addJob(job);
        return job;
    }

    return { runner, jobManager, ctx, queueJob };
}

describe("workflow1 non-live examples (converted to unit tests)", () => {
    it("basic workflow", async () => {
        const { runner, ctx, queueJob } = createHarness();

        const workflow = new WorkflowBuilder<{ first: string; second: string }>("basic-workflow-test")
            .node("first", () => queueJob(async () => "hello-workflow"))
            .after("first", "second", (_ctx, _client, _runner, state) =>
                queueJob(async () => `${String(state.values.first)}-processed`)
            )
            .aggregate((results) => ({
                first: String(results.first),
                second: String(results.second)
            }))
            .build();

        const execution = await runner.run(workflow, ctx);
        expect(execution.status).toBe("completed");
        expect(execution.output).toEqual({
            first: "hello-workflow",
            second: "hello-workflow-processed"
        });
    });

    it("provider chat shape workflow (non-live)", async () => {
        const { runner, ctx, queueJob } = createHarness();

        const workflow = new WorkflowBuilder<{ answerText: string; summaryText: string }>("provider-chat-workflow-test")
            .node("ask", () => queueJob(async () => "A workflow DAG is a directed acyclic dependency graph."))
            .after("ask", "summarize", (_ctx, _client, _runner, state) =>
                queueJob(async () => `Summary: ${String(state.values.ask)}`)
            )
            .aggregate((results) => ({
                answerText: String(results.ask ?? ""),
                summaryText: String(results.summarize ?? "")
            }))
            .build();

        const execution = await runner.run(workflow, ctx);
        expect(execution.status).toBe("completed");
        expect(execution.output.answerText).toContain("workflow DAG");
        expect(execution.output.summaryText).toContain("Summary:");
    });

    it("provider chat defaults shape workflow (non-live)", async () => {
        const { runner, ctx, queueJob } = createHarness();

        const workflow = new WorkflowBuilder<{ answerText: string; summaryText: string }>("provider-chat-defaults-workflow-test")
            .defaults({
                retry: { attempts: 2, backoffMs: 1 },
                timeoutMs: 1000
            })
            .node("ask", () => queueJob(async () => "Retries and checkpoints increase resilience."))
            .after("ask", "summarize", (_ctx, _client, _runner, state) =>
                queueJob(async () => `One sentence: ${String(state.values.ask)}`)
            )
            .aggregate((results) => ({
                answerText: String(results.ask ?? ""),
                summaryText: String(results.summarize ?? "")
            }))
            .build();

        const execution = await runner.run(workflow, ctx);
        expect(execution.status).toBe("completed");
        expect(execution.output.answerText.length).toBeGreaterThan(0);
        expect(execution.output.summaryText).toContain("One sentence:");
    });

    it("provider chat stream shape workflow (non-live)", async () => {
        const { jobManager, ctx, queueJob } = createHarness();
        let chunks = 0;

        const streamingRunner = new WorkflowRunner({
            jobManager,
            client: {} as any,
            hooks: {
                onNodeChunk: () => {
                    chunks += 1;
                }
            }
        });

        const workflow = new WorkflowBuilder<{ answerText: string }>("provider-chat-stream-workflow-test")
            .node("askStream", () =>
                queueJob(
                    async (onChunk) => {
                        onChunk?.({ delta: { text: "Hello " } }, { output: undefined, done: false });
                        onChunk?.({ delta: { text: "stream" } }, { output: undefined, done: false });
                        return "Hello stream";
                    },
                    true
                )
            )
            .aggregate((results) => ({ answerText: String(results.askStream ?? "") }))
            .build();

        const execution = await streamingRunner.run(workflow, ctx);
        expect(execution.status).toBe("completed");
        expect(execution.output.answerText).toBe("Hello stream");
        expect(chunks).toBeGreaterThan(0);
    });

    it("parallel fanout workflow", async () => {
        const { runner, ctx, queueJob } = createHarness();

        const workflow = new WorkflowBuilder<{ joined: string }>("parallel-fanout-workflow-test")
            .node("seed", () => queueJob(async () => "alpha"))
            .after("seed", "branchA", (_ctx, _client, _runner, state) => queueJob(async () => `${String(state.values.seed)}-A`))
            .after("seed", "branchB", (_ctx, _client, _runner, state) => queueJob(async () => `${String(state.values.seed)}-B`))
            .after(["branchA", "branchB"], "join", (_ctx, _client, _runner, state) =>
                queueJob(async () => `${String(state.values.branchA)}|${String(state.values.branchB)}`)
            )
            .aggregate((results) => ({ joined: String(results.join ?? "") }))
            .build();

        const execution = await runner.run(workflow, ctx);
        expect(execution.output).toEqual({ joined: "alpha-A|alpha-B" });
    });

    it("conditional skip workflow", async () => {
        const { runner, ctx, queueJob } = createHarness();

        const workflow = new WorkflowBuilder<{ draft: string; reviewed: string; published: string }>("conditional-workflow-test")
            .node("buildDraft", () => queueJob(async () => "draft-v1"))
            .after("buildDraft", "review", (_ctx, _client, _runner, state) => queueJob(async () => `${String(state.values.buildDraft)}-reviewed`), {
                condition: () => false
            })
            .after("buildDraft", "publish", (_ctx, _client, _runner, state) =>
                queueJob(async () => `${String(state.values.buildDraft)}-published`)
            )
            .aggregate((results) => ({
                draft: String(results.buildDraft ?? ""),
                reviewed: String(results.review ?? "SKIPPED"),
                published: String(results.publish ?? "")
            }))
            .build();

        const execution = await runner.run(workflow, ctx);
        expect(execution.output).toEqual({
            draft: "draft-v1",
            reviewed: "SKIPPED",
            published: "draft-v1-published"
        });
        expect(execution.results.find((r) => r.stepId === "review")?.skipped).toBe(true);
    });

    it("retry workflow", async () => {
        const { runner, ctx, queueJob } = createHarness();
        let attempts = 0;

        const workflow = new WorkflowBuilder<{ recovered: string }>("retry-workflow-test")
            .node(
                "unstable",
                () =>
                    queueJob(async () => {
                        attempts += 1;
                        if (attempts === 1) {
                            throw new Error("forced-failure-attempt-1");
                        }
                        return "recovered-value";
                    }),
                { retry: { attempts: 3, backoffMs: 1 } }
            )
            .aggregate((results) => ({ recovered: String(results.unstable ?? "") }))
            .build();

        const execution = await runner.run(workflow, ctx);
        expect(execution.output).toEqual({ recovered: "recovered-value" });
        expect(attempts).toBe(2);
    });

    it("timeout workflow", async () => {
        const { runner, ctx, queueJob } = createHarness();

        const workflow = new WorkflowBuilder("timeout-workflow-test")
            .node(
                "slowStep",
                () =>
                    queueJob(async () => {
                        await new Promise((resolve) => setTimeout(resolve, 250));
                        return "too-slow";
                    }),
                { timeoutMs: 50, retry: { attempts: 1 } }
            )
            .build();

        await expect(runner.run(workflow, ctx)).rejects.toMatchObject({ name: "WorkflowNodeTimeoutError" });
    });

    it("mixed controls workflow", async () => {
        const { runner, ctx, queueJob } = createHarness();
        let branchRetryAttempts = 0;

        const workflow = new WorkflowBuilder<{ final: string }>("mixed-controls-workflow-test")
            .node("seed", () => queueJob(async () => "doc-42"))
            .after("seed", "branchFast", (_ctx, _client, _runner, state) =>
                queueJob(async () => `${String(state.values.seed)}-fast`)
            )
            .after(
                "seed",
                "branchRetry",
                (_ctx, _client, _runner, state) =>
                    queueJob(async () => {
                        branchRetryAttempts += 1;
                        if (branchRetryAttempts === 1) {
                            throw new Error("forced-failure-attempt-1");
                        }
                        return `${String(state.values.seed)}-stable`;
                    }),
                { retry: { attempts: 3, backoffMs: 1 } }
            )
            .after("branchRetry", "review", (_ctx, _client, _runner, state) =>
                queueJob(async () => `${String(state.values.branchRetry)}-reviewed`)
            )
            .after(
                "branchFast",
                "audit",
                (_ctx, _client, _runner, state) => queueJob(async () => `${String(state.values.branchFast)}-audited`),
                { condition: () => false }
            )
            .after(["branchFast", "branchRetry", "review", "audit"], "join", (_ctx, _client, _runner, state) =>
                queueJob(async () =>
                    [
                        String(state.values.branchFast ?? ""),
                        String(state.values.branchRetry ?? ""),
                        String(state.values.review ?? ""),
                        String(state.values.audit ?? "SKIPPED")
                    ].join("|")
                )
            )
            .aggregate((results) => ({ final: String(results.join ?? "") }))
            .build();

        const execution = await runner.run(workflow, ctx);
        expect(execution.status).toBe("completed");
        expect(execution.output.final).toBe("doc-42-fast|doc-42-stable|doc-42-stable-reviewed|SKIPPED");
        expect(execution.results.find((r) => r.stepId === "audit")?.skipped).toBe(true);
    });

    it("mixed failure workflow", async () => {
        const startedSteps: string[] = [];
        const completedSteps: string[] = [];
        const { runner, ctx, queueJob } = createHarness({
            onNodeStart: (_wf, nodeId) => startedSteps.push(nodeId),
            onNodeComplete: (_wf, nodeId) => completedSteps.push(nodeId)
        });

        const workflow = new WorkflowBuilder("mixed-failure-workflow-test")
            .node("seed", () => queueJob(async () => "doc-99"))
            .after("seed", "branchOk", (_ctx, _client, _runner, state) =>
                queueJob(async () => `${String(state.values.seed)}-ok`)
            )
            .after(
                "seed",
                "branchFail",
                () =>
                    queueJob(async () => {
                        throw new Error("forced-failure");
                    }),
                { retry: { attempts: 2, backoffMs: 1 } }
            )
            .after(["branchOk", "branchFail"], "join", (_ctx, _client, _runner, state) =>
                queueJob(async () => `${String(state.values.branchOk)}|${String(state.values.branchFail)}`)
            )
            .build();

        await expect(runner.run(workflow, ctx)).rejects.toThrow("forced-failure");
        expect(startedSteps).toContain("branchFail");
        expect(completedSteps).toContain("seed");
        expect(completedSteps).not.toContain("join");
    });

    it("nested workflow", async () => {
        const { runner, ctx, queueJob } = createHarness();

        const childWorkflow = new WorkflowBuilder<{ childResult: string }>("child-echo-workflow-test")
            .node("childStepA", (_ctx, _client, _runner, state) => queueJob(async () => `${String(state.values.input)}-child-a`))
            .after("childStepA", "childStepB", (_ctx, _client, _runner, state) =>
                queueJob(async () => `${String(state.values.childStepA)}-child-b`)
            )
            .aggregate((results) => ({ childResult: String(results.childStepB ?? "") }))
            .build();

        const parentWorkflow = new WorkflowBuilder<{ final: string; nested: { childResult: string } }>("parent-nested-workflow-test")
            .node("prepareInput", () => queueJob(async () => "nested-base"))
            .after("prepareInput", "runChild", (_ctx, _client, nestedRunner, state) =>
                nestedRunner.createWorkflowJob(childWorkflow, {
                    values: { input: state.values.prepareInput }
                })
            )
            .after("runChild", "finalize", (_ctx, _client, _runner, state) =>
                queueJob(async () => `${String(state.values.prepareInput)}|${String((state.values.runChild as any).childResult)}`)
            )
            .aggregate((results) => ({
                nested: results.runChild as { childResult: string },
                final: String(results.finalize ?? "")
            }))
            .build();

        const execution = await runner.run(parentWorkflow, ctx);
        expect(execution.status).toBe("completed");
        expect(execution.output).toEqual({
            nested: { childResult: "nested-base-child-a-child-b" },
            final: "nested-base|nested-base-child-a-child-b"
        });
    });

    it("nested failure workflow", async () => {
        const startedSteps: string[] = [];
        const completedSteps: string[] = [];
        const { runner, ctx, queueJob } = createHarness({
            onNodeStart: (_wf, nodeId) => startedSteps.push(nodeId),
            onNodeComplete: (_wf, nodeId) => completedSteps.push(nodeId)
        });

        const childWorkflow = new WorkflowBuilder("child-failure-workflow-test")
            .node("childStepA", (_ctx, _client, _runner, state) => queueJob(async () => `${String(state.values.input)}-child-a`))
            .after(
                "childStepA",
                "childStepFail",
                () =>
                    queueJob(async () => {
                        throw new Error("forced-child-failure");
                    }),
                { retry: { attempts: 2, backoffMs: 1 } }
            )
            .build();

        const parentWorkflow = new WorkflowBuilder("parent-nested-failure-workflow-test")
            .node("prepareInput", () => queueJob(async () => "nested-failure-base"))
            .after("prepareInput", "runChild", (_ctx, _client, nestedRunner, state) =>
                nestedRunner.createWorkflowJob(childWorkflow, {
                    values: { input: state.values.prepareInput }
                })
            )
            .after("runChild", "finalize", () => queueJob(async () => "should-not-run"))
            .build();

        await expect(runner.run(parentWorkflow, ctx)).rejects.toThrow("forced-child-failure");
        expect(startedSteps).toContain("runChild");
        expect(completedSteps).toContain("childStepA");
        expect(completedSteps).not.toContain("finalize");
    });

    it("resume workflow", async () => {
        const { jobManager, ctx, queueJob } = createHarness();
        const snapshots = new Map<string, any>();
        let failStep2Once = true;

        const resumableRunner = new WorkflowRunner({
            jobManager,
            client: {} as any,
            persistence: {
                persistWorkflowExecution: async (snapshot) => {
                    snapshots.set(snapshot.workflowId, snapshot);
                },
                loadWorkflowExecution: async (workflowId) => snapshots.get(workflowId)
            }
        });

        const workflow = new WorkflowBuilder<{ step1: string; step2: string; step3: string }>("resume-demo-workflow-test")
            .node("step1", () => queueJob(async () => "resume-seed"))
            .after("step1", "step2", (_ctx, _client, _runner, state) =>
                queueJob(async () => {
                    if (failStep2Once) {
                        failStep2Once = false;
                        throw new Error("intentional-step2-failure");
                    }
                    return `${String(state.values.step1)}-step2`;
                })
            )
            .after("step2", "step3", (_ctx, _client, _runner, state) =>
                queueJob(async () => `${String(state.values.step2)}-step3`)
            )
            .aggregate((results) => ({
                step1: String(results.step1 ?? ""),
                step2: String(results.step2 ?? ""),
                step3: String(results.step3 ?? "")
            }))
            .build();

        await expect(resumableRunner.run(workflow, ctx)).rejects.toThrow("intentional-step2-failure");
        expect(snapshots.get(workflow.id)?.completedNodeIds).toEqual(["step1"]);

        const resumed = await resumableRunner.resume(workflow, ctx);
        expect(resumed.status).toBe("completed");
        expect(resumed.output).toEqual({
            step1: "resume-seed",
            step2: "resume-seed-step2",
            step3: "resume-seed-step2-step3"
        });
    });
});
