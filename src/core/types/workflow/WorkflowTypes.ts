/**
 * @module core/types/workflow/WorkflowTypes.ts
 * @description Core shared type definitions used by runtime, providers, and workflows.
 */
import { AIClient, GenericJob, MultiModalExecutionContext, ProviderRef } from "#root/index.js";
import type { WorkflowRunner } from "#root/index.js";
/**
 * Current persisted schema version for workflow execution snapshots.
 */
/**
 * @public
 * @description Runtime constant for WORKFLOW_EXECUTION_SNAPSHOT_SCHEMA_VERSION.
 */
export const WORKFLOW_EXECUTION_SNAPSHOT_SCHEMA_VERSION = 1 as const;

/**
 * High-level lifecycle status for a workflow execution.
 *
 * @public
 */
export type WorkflowStatus = "pending" | "running" | "completed" | "error" | "aborted";

/**
 * Retry configuration for an individual workflow node.
 *
 * @public
 */
export interface WorkflowRetryPolicy {
    /**
     * Maximum number of attempts (including the first attempt).
     */
    attempts: number;
    /**
     * Optional fixed backoff delay between attempts, in milliseconds.
     */
    backoffMs?: number;
}

/**
 * Mutable workflow-scoped key/value store shared across nodes.
 *
 * @public
 */
export interface WorkflowState {
    /**
     * Shared mutable value bag keyed by node id or custom state keys.
     */
    values: Record<string, unknown>;
}

/**
 * Workflow-level default policy values.
 * Node-level values always take precedence when explicitly set.
 *
 * @public
 */
export interface WorkflowDefaults {
    /**
     * Default retry policy applied when a node does not define `retry`.
     */
    retry?: WorkflowRetryPolicy;
    /**
     * Default node timeout applied when a node does not define `timeoutMs`.
     */
    timeoutMs?: number;
    /**
     * Default provider chain for capability-backed builder helpers.
     */
    providerChain?: ProviderRef[];
    /**
     * Default `addToManager` behavior for capability-backed builder helpers.
     */
    addToManager?: boolean;
}

/**
 * Executable node in a workflow DAG.
 *
 * @public
 */
export interface WorkflowNode {
    /**
     * Unique node identifier within a workflow.
     */
    id: string;

    /**
     * Node executor. Must return a {@link GenericJob} instance.
     *
     * @param ctx Shared multimodal execution context
     * @param client AI client instance
     * @param runner Workflow runner instance executing this node
     * @param state Shared mutable workflow state
     */
    run: (
        ctx: MultiModalExecutionContext,
        client: AIClient,
        runner: WorkflowRunner,
        state: WorkflowState
    ) => GenericJob<any, any>;

    /**
     * Optional state-based guard that controls whether the node should execute.
     * Return `false` to mark the node as skipped.
     */
    condition?: (state: WorkflowState) => boolean;
    /**
     * List of node IDs that must complete before this node becomes runnable.
     */
    dependsOn?: string[];
    /**
     * Optional retry policy for node failures.
     */
    retry?: WorkflowRetryPolicy;
    /**
     * Optional timeout for the node execution, in milliseconds.
     */
    timeoutMs?: number;
}

/**
 * Workflow definition composed of DAG nodes and optional final aggregation.
 *
 * @typeParam TOutput Final aggregated output type
 * @public
 */
export interface Workflow<TOutput = unknown> {
    /**
     * Unique workflow identifier.
     */
    id: string;
    /**
     * Optional user-defined workflow version used for resume compatibility checks.
     */
    version?: string | number;
    /**
     * DAG nodes to execute.
     */
    nodes: WorkflowNode[];
    /**
     * Optional default policies used by runner/builder helpers.
     */
    defaults?: WorkflowDefaults;
    /**
     * Optional function used to produce a final workflow output.
     */
    aggregate?: (results: Record<string, unknown>, state: WorkflowState) => TOutput;
}

/**
 * Result for a single workflow node execution.
 *
 * @public
 */
export interface WorkflowStepResult {
    /**
     * Node identifier.
     */
    stepId: string;
    /**
     * Job IDs created by this step (empty when skipped).
     */
    jobIds: string[];
    /**
     * Raw outputs returned by the node job(s).
     */
    outputs: unknown[];
    /**
     * Whether the node was skipped due to its condition evaluating to false.
     */
    skipped?: boolean;
    /**
     * Start timestamp (epoch ms).
     */
    startedAt?: number;
    /**
     * End timestamp (epoch ms).
     */
    endedAt?: number;
    /**
     * Total duration in milliseconds.
     */
    durationMs?: number;
    /**
     * Number of execution attempts made for this node.
     */
    attemptCount?: number;
    /**
     * Per-attempt metrics in execution order (attempt 1..N).
     */
    attempts?: WorkflowStepAttemptMetric[];
    /**
     * Number of retries performed (attemptCount - 1).
     */
    retryCount?: number;
    /**
     * Sum of all attempt durations in milliseconds.
     */
    totalAttemptDurationMs?: number;
}

/**
 * Metrics for a single node attempt within a workflow step execution.
 *
 * @public
 */
export interface WorkflowStepAttemptMetric {
    /**
     * 1-based attempt index.
     */
    attempt: number;
    /**
     * Optional job id created for this attempt.
     */
    jobId?: string;
    /**
     * Attempt start timestamp (epoch ms).
     */
    startedAt: number;
    /**
     * Attempt end timestamp (epoch ms).
     */
    endedAt: number;
    /**
     * Attempt duration in milliseconds.
     */
    durationMs: number;
    /**
     * Attempt terminal status.
     */
    status: "completed" | "error" | "timeout" | "aborted";
    /**
     * Error name when attempt did not complete successfully.
     */
    errorName?: string;
    /**
     * Error message when attempt did not complete successfully.
     */
    errorMessage?: string;
}

/**
 * Final workflow execution payload.
 *
 * @typeParam TOutput Final aggregated output type
 * @public
 */
export interface WorkflowExecution<TOutput = unknown> {
    /**
     * Workflow identifier.
     */
    workflowId: string;
    /**
     * Final workflow status.
     */
    status: WorkflowStatus;
    /**
     * Per-node execution results.
     */
    results: WorkflowStepResult[];
    /**
     * Optional aggregated output.
     */
    output?: TOutput;
    /**
     * Final shared workflow state snapshot.
     */
    state: WorkflowState;
    /**
     * Workflow start timestamp (epoch ms).
     */
    startedAt?: number;
    /**
     * Workflow end timestamp (epoch ms).
     */
    endedAt?: number;
    /**
     * Total workflow duration in milliseconds.
     */
    durationMs?: number;
}

/**
 * Persistable workflow execution snapshot used for resume/recovery.
 *
 * @typeParam TOutput Final aggregated output type
 * @public
 */
export interface WorkflowExecutionSnapshot<TOutput = unknown> {
    /**
     * Snapshot schema version.
     */
    schemaVersion: number;
    /**
     * Workflow identifier.
     */
    workflowId: string;
    /**
     * Optional workflow version captured at snapshot time.
     */
    workflowVersion?: string | number;
    /**
     * Current workflow status.
     */
    status: WorkflowStatus;
    /**
     * IDs of nodes already completed (including skipped nodes).
     */
    completedNodeIds: string[];
    /**
     * Per-node execution results accumulated so far.
     */
    results: WorkflowStepResult[];
    /**
     * Optional aggregated output when workflow reached terminal completion.
     */
    output?: TOutput;
    /**
     * Current shared workflow state.
     */
    state: WorkflowState;
    /**
     * First start timestamp (epoch ms).
     */
    startedAt: number;
    /**
     * Last persisted timestamp (epoch ms).
     */
    updatedAt: number;
    /**
     * Workflow end timestamp (epoch ms) when terminal.
     */
    endedAt?: number;
    /**
     * Total workflow duration in milliseconds when terminal.
     */
    durationMs?: number;
}
