import {
    AIClient,
    JobManager,
    MultiModalExecutionContext,
    Workflow,
    WorkflowExecution,
    WorkflowNode,
    WorkflowState,
    WorkflowStepResult
} from "#root/index.js";

export interface WorkflowRunnerHooks {
    onWorkflowStart?: (workflowId: string) => void;
    onWorkflowComplete?: (workflowId: string, execution: WorkflowExecution<any>) => void;
    onWorkflowError?: (workflowId: string, error: Error, execution: WorkflowExecution<any>) => void;
    onNodeStart?: (workflowId: string, nodeId: string) => void;
    onNodeComplete?: (workflowId: string, nodeId: string, result: WorkflowStepResult) => void;
}

export class WorkflowRunner {
    constructor(
        private jobManager: JobManager,
        private client: AIClient,
        private hooks?: WorkflowRunnerHooks
    ) {}

    async run<TOutput>(
        workflow: Workflow<TOutput>,
        ctx: MultiModalExecutionContext,
        initialState?: WorkflowState
    ): Promise<WorkflowExecution<TOutput>> {
        this.validateWorkflow(workflow);

        const state: WorkflowState = initialState ?? { values: {} };

        const execution: WorkflowExecution<TOutput> = {
            workflowId: workflow.id,
            status: "running",
            results: [],
            state
        };

        const completed = new Set<string>();
        const running = new Set<string>();
        const resultsByNode = new Map<string, unknown>();

        this.hooks?.onWorkflowStart?.(workflow.id);

        try {
            while (completed.size < workflow.nodes.length) {
                const readyNodes: WorkflowNode[] = [];

                // NOTE: This is O(n^2) in the worst case, but we expect workflows to be relatively small(< 50 nodes).
                // If performance becomes an issue, we can optimize this with maybe a Topological sort.  For now
                // this is simpler and more flexible (allows dynamic conditions) than a full topological sort.
                // Also, runtime is dominated by the actual job executions, so this is unlikely to be a bottleneck in practice.
                for (const node of workflow.nodes) {
                    if (completed.has(node.id) || running.has(node.id)) {
                        continue;
                    }

                    const satisfied = (node.dependsOn ?? []).every((dep) => completed.has(dep));
                    if (!satisfied) {
                        continue;
                    }

                    if (node.condition && !node.condition(state)) {
                        const timeMs = Date.now();
                        // Mark as skipped by adding to completed without running
                        completed.add(node.id);
                        execution.results.push({
                            stepId: node.id,
                            jobIds: [],
                            outputs: [],
                            skipped: true,
                            durationMs: 0,
                            startedAt: timeMs,
                            endedAt: timeMs
                        });

                        continue;
                    }

                    readyNodes.push(node);
                }

                if (readyNodes.length === 0) {
                    throw new Error(
                        `WorkflowRunner: no runnable nodes found for workflow '${workflow.id}' (possible cycle, unresolved dependency, or deadlock)`
                    );
                }

                await Promise.all(
                    readyNodes.map(async (node) => {
                        running.add(node.id);
                        this.hooks?.onNodeStart?.(workflow.id, node.id);

                        try {
                            const result = await this.runNodeWithRetry(workflow.id, node, ctx, state);
                            const output = result.outputs[0];

                            resultsByNode.set(node.id, output);
                            state.values[node.id] = output;

                            completed.add(node.id);

                            execution.results.push(result);
                            this.hooks?.onNodeComplete?.(workflow.id, node.id, result);

                            return result;
                        } finally {
                            running.delete(node.id);
                        }
                    })
                );
            }

            if (workflow.aggregate) {
                const aggregateInput: Record<string, unknown> = {};
                for (const [nodeId, value] of resultsByNode.entries()) {
                    aggregateInput[nodeId] = value;
                }

                execution.output = workflow.aggregate(aggregateInput, state);
            }

            execution.status = "completed";
            this.hooks?.onWorkflowComplete?.(workflow.id, execution);

            return execution;
        } catch (err) {
            execution.status = "error";
            const normalized = err instanceof Error ? err : new Error(String(err));
            this.hooks?.onWorkflowError?.(workflow.id, normalized, execution);
            throw normalized;
        }
    }

    private async runNodeWithRetry(
        workflowId: string,
        node: WorkflowNode,
        ctx: MultiModalExecutionContext,
        state: WorkflowState
    ): Promise<WorkflowStepResult> {
        const maxAttempts = Math.max(node.retry?.attempts ?? 1, 1);
        const backoffMs = Math.max(node.retry?.backoffMs ?? 0, 0);

        let lastError: Error | undefined;

        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            try {
                const startTime = Date.now();

                const job = node.run(ctx, this.client, state);

                this.jobManager.runJob(job.id, ctx);

                const output = node.timeoutMs
                    ? await Promise.race([job.getCompletionPromise(), this.timeout(node.timeoutMs)])
                    : await job.getCompletionPromise();

                const endTime = Date.now();
                const durationMs = endTime - startTime;

                return {
                    stepId: node.id,
                    jobIds: [job.id],
                    outputs: [output],
                    startedAt: startTime,
                    endedAt: endTime,
                    durationMs
                };
            } catch (err) {
                lastError = err instanceof Error ? err : new Error(String(err));

                if (attempt >= maxAttempts) {
                    throw lastError;
                }

                if (backoffMs > 0) {
                    await this.delay(backoffMs);
                }
            }
        }

        throw (
            lastError ??
            new Error(`WorkflowRunner: node '${node.id}' in workflow '${workflowId}' failed unexpectedly without error`)
        );
    }

    private validateWorkflow(workflow: Workflow<any>) {
        const ids = new Set<string>();

        for (const node of workflow.nodes) {
            if (ids.has(node.id)) {
                throw new Error(`WorkflowRunner: duplicate node id '${node.id}'`);
            }
            ids.add(node.id);
        }

        for (const node of workflow.nodes) {
            for (const dep of node.dependsOn ?? []) {
                if (!ids.has(dep)) {
                    throw new Error(`WorkflowRunner: node '${node.id}' depends on unknown node '${dep}'`);
                }
            }
        }

        this.validateNoCycles(workflow);
    }

    private validateNoCycles(workflow: Workflow<any>) {
        const visiting = new Set<string>();
        const visited = new Set<string>();
        const nodeMap = new Map(workflow.nodes.map((node) => [node.id, node]));

        const visit = (nodeId: string) => {
            if (visited.has(nodeId)) {
                return;
            }
            if (visiting.has(nodeId)) {
                throw new Error(`WorkflowRunner: cycle detected at node '${nodeId}'`);
            }

            visiting.add(nodeId);

            const node = nodeMap.get(nodeId);
            if (!node) {
                return;
            }

            for (const dep of node.dependsOn ?? []) {
                visit(dep);
            }

            visiting.delete(nodeId);
            visited.add(nodeId);
        };

        for (const node of workflow.nodes) {
            visit(node.id);
        }
    }

    private delay(ms: number): Promise<void> {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }

    private timeout(msTimeout: number): Promise<void> {
        return new Promise((_, reject) => {
            setTimeout(() => reject(new Error(`WorkflowRunner: node execution exceeded timeout of ${msTimeout}ms`)), msTimeout);
        });
    }
}
