import { AIClient, GenericJob, MultiModalExecutionContext } from "#root/index.js";

export type WorkflowStatus = "pending" | "running" | "completed" | "error" | "aborted";

export interface WorkflowRetryPolicy {
    attempts: number;
    backoffMs?: number;
}

export interface WorkflowState {
    values: Record<string, unknown>;
}

export interface WorkflowNode {
    id: string;

    run: (ctx: MultiModalExecutionContext, client: AIClient, state: WorkflowState) => GenericJob<any, any>;

    condition?: (state: WorkflowState) => boolean;

    dependsOn?: string[];
    retry?: WorkflowRetryPolicy;
    timeoutMs?: number;
}

export interface Workflow<TOutput = unknown> {
    id: string;
    nodes: WorkflowNode[];
    aggregate?: (results: Record<string, unknown>, state: WorkflowState) => TOutput;
}

export interface WorkflowStepResult {
    stepId: string;
    jobIds: string[];
    outputs: unknown[];
    skipped?: boolean;
    startedAt?: number;
    endedAt?: number;
    durationMs?: number;
}

export interface WorkflowExecution<TOutput = unknown> {
    workflowId: string;
    status: WorkflowStatus;
    results: WorkflowStepResult[];
    output?: TOutput;
    state: WorkflowState;
}
