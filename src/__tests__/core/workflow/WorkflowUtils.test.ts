import { describe, expect, it, vi } from "vitest";
import {
    AIClient,
    GenericJob,
    JobManager,
    JobSnapshot,
    MultiModalExecutionContext,
    WorkflowBuilder,
    WorkflowExecutionSnapshot,
    WorkflowRunner,
    WORKFLOW_EXECUTION_SNAPSHOT_SCHEMA_VERSION,
    createWorkflowRuntime
} from "#root/index.js";

function makeGenericJob(id: string, completion: Promise<string>) {
    return new GenericJob<string, string>("input", false, async () => ({
        output: await completion,
        rawResponse: { value: "raw" },
        id,
        metadata: {}
    }));
}

describe("createWorkflowRuntime", () => {
    it("returns a wired runtime bundle with a default no-resume policy", () => {
        const runtime = createWorkflowRuntime({});

        expect(runtime.jobManager).toBeInstanceOf(JobManager);
        expect(runtime.client).toBeInstanceOf(AIClient);
        expect(runtime.runner).toBeInstanceOf(WorkflowRunner);
        expect(runtime.client.jobManager).toBe(runtime.jobManager);
        expect(runtime.shouldResumeWorkflow("wf-any")).toBe(false);
    });

    it("returns the supplied shouldResumeWorkflow policy", () => {
        const shouldResumeWorkflow = vi.fn((workflowId: string) => workflowId === "resume-me");
        const runtime = createWorkflowRuntime({ shouldResumeWorkflow });

        expect(runtime.shouldResumeWorkflow("resume-me")).toBe(true);
        expect(runtime.shouldResumeWorkflow("fresh-run")).toBe(false);
        expect(shouldResumeWorkflow).toHaveBeenCalledWith("resume-me");
        expect(shouldResumeWorkflow).toHaveBeenCalledWith("fresh-run");
    });

    it("forwards job persistence callbacks to JobManager", async () => {
        const persistJobs = vi.fn();
        const loadPersistedJobs = vi.fn<JobSnapshot<any, any>[], []>(() => []);
        const runtime = createWorkflowRuntime({ persistJobs, loadPersistedJobs });

        expect(loadPersistedJobs).toHaveBeenCalledTimes(1);

        const ctx = new MultiModalExecutionContext();
        const completion = Promise.resolve("done");
        const job = makeGenericJob("job-utils-persist", completion);

        runtime.jobManager.addJob(job);
        runtime.jobManager.runJob(job.id, ctx);
        await job.getCompletionPromise();
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(persistJobs).toHaveBeenCalled();
        const latestSnapshots = persistJobs.mock.calls.at(-1)?.[0] as JobSnapshot<any, any>[];
        expect(latestSnapshots.some((snapshot) => snapshot.id === job.id)).toBe(true);
    });

    it("passes workflow persistence callbacks into WorkflowRunner", async () => {
        const persistWorkflowExecution = vi.fn<
            void | Promise<void>,
            [WorkflowExecutionSnapshot<any>]
        >();
        const loadWorkflowExecution = vi.fn<
            WorkflowExecutionSnapshot<any> | undefined | Promise<WorkflowExecutionSnapshot<any> | undefined>,
            [string]
        >(() => undefined);

        const runtime = createWorkflowRuntime({
            persistWorkflowExecution,
            loadWorkflowExecution
        });

        const workflow = new WorkflowBuilder<{ finalText: string }>("wf-utils-persist")
            .node("first", () => {
                const job = makeGenericJob("job-first", Promise.resolve("hello"));
                runtime.jobManager.addJob(job);
                return job;
            })
            .after("first", "second", (_ctx, _client, _runner, state) => {
                const job = makeGenericJob("job-second", Promise.resolve(`${String(state.values.first)} world`));
                runtime.jobManager.addJob(job);
                return job;
            })
            .aggregate((results) => ({
                finalText: String(results.second)
            }))
            .build();

        const execution = await runtime.runner.run(workflow, new MultiModalExecutionContext());

        expect(execution.status).toBe("completed");
        expect(loadWorkflowExecution).not.toHaveBeenCalled();
        expect(persistWorkflowExecution).toHaveBeenCalled();

        const snapshots = persistWorkflowExecution.mock.calls.map(([snapshot]) => snapshot);
        expect(snapshots.some((snapshot) => snapshot.status === "running")).toBe(true);
        expect(snapshots.at(-1)?.status).toBe("completed");
        expect(snapshots.at(-1)?.workflowId).toBe("wf-utils-persist");
    });

    it("supports workflow resume through the forwarded loader callback", async () => {
        const persistWorkflowExecution = vi.fn<
            void | Promise<void>,
            [WorkflowExecutionSnapshot<any>]
        >();
        const loadWorkflowExecution = vi.fn<
            WorkflowExecutionSnapshot<any> | undefined | Promise<WorkflowExecutionSnapshot<any> | undefined>,
            [string]
        >((workflowId: string) =>
            workflowId === "wf-utils-resume"
                ? ({
                      schemaVersion: WORKFLOW_EXECUTION_SNAPSHOT_SCHEMA_VERSION,
                      workflowId,
                      workflowVersion: 1,
                      status: "running",
                      completedNodeIds: ["first"],
                      state: {
                          values: { first: "persisted-first" }
                      },
                      results: [
                          {
                              stepId: "first",
                              outputs: ["persisted-first"],
                              status: "completed",
                              startedAt: Date.now(),
                              endedAt: Date.now(),
                              durationMs: 0,
                              jobIds: ["job-first"],
                              attemptCount: 1,
                              retryCount: 0,
                              totalAttemptDurationMs: 0,
                              skipped: false,
                              attempts: []
                          }
                      ],
                      updatedAt: Date.now(),
                      endedAt: undefined
                  } satisfies WorkflowExecutionSnapshot<any>)
                : undefined
        );

        const runtime = createWorkflowRuntime({
            persistWorkflowExecution,
            loadWorkflowExecution
        });

        const secondNode = vi.fn((_ctx, _client, _runner, state) =>
            {
                const job = makeGenericJob("job-second", Promise.resolve(`${String(state.values.first)}-second`));
                runtime.jobManager.addJob(job);
                return job;
            }
        );

        const workflow = new WorkflowBuilder<{ finalText: string }>("wf-utils-resume")
            .node("first", () => {
                const job = makeGenericJob("job-first", Promise.resolve("fresh-first"));
                runtime.jobManager.addJob(job);
                return job;
            })
            .after("first", "second", secondNode)
            .aggregate((results) => ({
                finalText: String(results.second)
            }))
            .build();

        const execution = await runtime.runner.resume(workflow, new MultiModalExecutionContext());

        expect(loadWorkflowExecution).toHaveBeenCalledWith("wf-utils-resume");
        expect(secondNode).toHaveBeenCalledTimes(1);
        expect(execution.status).toBe("completed");
        expect(execution.state.values.first).toBe("persisted-first");
        expect(execution.state.values.second).toBe("persisted-first-second");
    });
});
