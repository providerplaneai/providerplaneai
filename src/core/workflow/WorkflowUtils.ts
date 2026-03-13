/**
 * @module core/workflow/WorkflowUtils.ts
 * @description Runtime composition helpers for wiring JobManager, AIClient, and WorkflowRunner together.
 */
import {
    AIClient,
    JobManager,
    JobManagerOptions,
    WorkflowExecutionSnapshot,
    WorkflowRunner,
    WorkflowRunnerHooks
} from "#root/index.js";

/**
 * Options for {@link createWorkflowRuntime}.
 *
 * @public
 */
export interface CreateWorkflowRuntimeOptions {
    /**
     * Optional workflow lifecycle hooks forwarded to {@link WorkflowRunner}.
     */
    hooks?: WorkflowRunnerHooks;
    /**
     * Optional job snapshot persistence callback forwarded to {@link JobManager}.
     */
    persistJobs?: JobManagerOptions["persistJobs"];
    /**
     * Optional job snapshot loader forwarded to {@link JobManager}.
     */
    loadPersistedJobs?: JobManagerOptions["loadPersistedJobs"];
    /**
     * Optional workflow execution snapshot persistence callback forwarded to {@link WorkflowRunner}.
     */
    persistWorkflowExecution?: (snapshot: WorkflowExecutionSnapshot<any>) => void | Promise<void>;
    /**
     * Optional workflow execution snapshot loader forwarded to {@link WorkflowRunner}.
     */
    loadWorkflowExecution?: (
        workflowId: string
    ) => WorkflowExecutionSnapshot<any> | undefined | Promise<WorkflowExecutionSnapshot<any> | undefined>;
    /**
     * Optional policy function that decides whether a workflow should resume instead of starting fresh.
     */
    shouldResumeWorkflow?: (workflowId: string) => boolean;
}

/**
 * Runtime bundle returned by {@link createWorkflowRuntime}.
 *
 * @public
 */
export interface WorkflowRuntime {
    /**
     * Job manager used for queued execution and optional job persistence.
     */
    jobManager: JobManager;
    /**
     * AI client wired to the runtime's {@link JobManager}.
     */
    client: AIClient;
    /**
     * Workflow runner wired to the runtime's {@link JobManager}, {@link AIClient}, hooks, and persistence callbacks.
     */
    runner: WorkflowRunner;
    /**
     * Helper policy function for deciding whether a workflow id should resume from persisted state.
     */
    shouldResumeWorkflow: (workflowId: string) => boolean;
}

/**
 * Creates a small runtime bundle that composes {@link JobManager}, {@link AIClient}, and {@link WorkflowRunner}.
 *
 * This is useful when an application wants one place to wire job persistence, workflow persistence,
 * workflow hooks, and resume policy before running workflows.
 *
 * @param options Runtime composition options
 * @param options.hooks Optional workflow lifecycle hooks forwarded to {@link WorkflowRunner}
 * @param options.persistJobs Optional job snapshot persistence callback forwarded to {@link JobManager}
 * @param options.loadPersistedJobs Optional job snapshot loader forwarded to {@link JobManager}
 * @param options.persistWorkflowExecution Optional workflow execution snapshot persistence callback forwarded to {@link WorkflowRunner}
 * @param options.loadWorkflowExecution Optional workflow execution snapshot loader forwarded to {@link WorkflowRunner}
 * @param options.shouldResumeWorkflow Optional policy function that decides whether a workflow id should resume instead of starting fresh
 * @returns Runtime bundle containing the composed {@link JobManager}, {@link AIClient}, {@link WorkflowRunner}, and resume policy helper
 * @public
 */
export function createWorkflowRuntime({
    hooks,
    persistJobs,
    loadPersistedJobs,
    persistWorkflowExecution,
    loadWorkflowExecution,
    shouldResumeWorkflow
}: CreateWorkflowRuntimeOptions): WorkflowRuntime {
    const jobManager = new JobManager({ persistJobs, loadPersistedJobs });
    const client = new AIClient(jobManager);
    const runner = new WorkflowRunner({
        jobManager,
        client,
        hooks,
        persistence: {
            persistWorkflowExecution,
            loadWorkflowExecution
        }
    });

    return {
        jobManager,
        client,
        runner,
        shouldResumeWorkflow: shouldResumeWorkflow ?? (() => false)
    };
}
