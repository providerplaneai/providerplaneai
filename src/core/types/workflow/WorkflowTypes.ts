import { AIClient, GenericJob, MultiModalExecutionContext } from "#root/index.js";

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
    /** Maximum number of attempts (including the first attempt). */
    attempts: number;
    /** Optional fixed backoff delay between attempts, in milliseconds. */
    backoffMs?: number;
}

/**
 * Mutable workflow-scoped key/value store shared across nodes.
 *
 * @public
 */
export interface WorkflowState {
    values: Record<string, unknown>;
}

/**
 * Executable node in a workflow DAG.
 *
 * @public
 */
export interface WorkflowNode {
    /** Unique node identifier within a workflow. */
    id: string;

    /**
     * Node executor. Must return a {@link GenericJob} instance.
     *
     * @param ctx Shared multimodal execution context
     * @param client AI client instance
     * @param state Shared mutable workflow state
     */
    run: (ctx: MultiModalExecutionContext, client: AIClient, state: WorkflowState) => GenericJob<any, any>;

    /**
     * Optional state-based guard that controls whether the node should execute.
     * Return `false` to mark the node as skipped.
     */
    condition?: (state: WorkflowState) => boolean;

    /** List of node IDs that must complete before this node becomes runnable. */
    dependsOn?: string[];
    /** Optional retry policy for node failures. */
    retry?: WorkflowRetryPolicy;
    /** Optional timeout for the node execution, in milliseconds. */
    timeoutMs?: number;
}

/**
 * Workflow definition composed of DAG nodes and optional final aggregation.
 *
 * @typeParam TOutput Final aggregated output type
 * @public
 */
export interface Workflow<TOutput = unknown> {
    /** Unique workflow identifier. */
    id: string;
    /** DAG nodes to execute. */
    nodes: WorkflowNode[];
    /** Optional function used to produce a final workflow output. */
    aggregate?: (results: Record<string, unknown>, state: WorkflowState) => TOutput;
}

/**
 * Result for a single workflow node execution.
 *
 * @public
 */
export interface WorkflowStepResult {
    /** Node identifier. */
    stepId: string;
    /** Job IDs created by this step (empty when skipped). */
    jobIds: string[];
    /** Raw outputs returned by the node job(s). */
    outputs: unknown[];
    /** Whether the node was skipped due to its condition evaluating to false. */
    skipped?: boolean;
    /** Start timestamp (epoch ms). */
    startedAt?: number;
    /** End timestamp (epoch ms). */
    endedAt?: number;
    /** Total duration in milliseconds. */
    durationMs?: number;
}

/**
 * Final workflow execution payload.
 *
 * @typeParam TOutput Final aggregated output type
 * @public
 */
export interface WorkflowExecution<TOutput = unknown> {
    /** Workflow identifier. */
    workflowId: string;
    /** Final workflow status. */
    status: WorkflowStatus;
    /** Per-node execution results. */
    results: WorkflowStepResult[];
    /** Optional aggregated output. */
    output?: TOutput;
    /** Final shared workflow state snapshot. */
    state: WorkflowState;
}
