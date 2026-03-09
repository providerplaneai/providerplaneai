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

/**
 * Lifecycle hooks emitted by {@link WorkflowRunner}.
 *
 * @public
 */
export interface WorkflowRunnerHooks {
    /** Called once when workflow execution starts. */
    onWorkflowStart?: (workflowId: string) => void;
    /** Called once when workflow execution completes successfully. */
    onWorkflowComplete?: (workflowId: string, execution: WorkflowExecution<any>) => void;
    /** Called once when workflow execution fails. */
    onWorkflowError?: (workflowId: string, error: Error, execution: WorkflowExecution<any>) => void;
    /** Called when a node starts executing. */
    onNodeStart?: (workflowId: string, nodeId: string) => void;
    /** Called when a node completes (including retries resolved). */
    onNodeComplete?: (workflowId: string, nodeId: string, result: WorkflowStepResult) => void;
}

/**
 * DAG workflow execution engine built on top of JobManager/GenericJob.
 */
export class WorkflowRunner {
    /**
     * @param jobManager Job scheduler used to run child jobs
     * @param client AIClient instance passed into workflow nodes
     * @param hooks Optional workflow lifecycle hooks
     */
    constructor(
        private jobManager: JobManager,
        private client: AIClient,
        private hooks?: WorkflowRunnerHooks
    ) {}

    /**
     * Executes a workflow until all nodes complete, are skipped, or an error occurs.
     *
     * @typeParam TOutput Final aggregate output type
     * @param workflow Workflow definition
     * @param ctx Shared multimodal execution context
     * @param initialState Optional initial state seed
     * @returns Final workflow execution result
     * @throws {Error} On validation failures, deadlocks, or node failures
     */
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
                let madeProgress = false;

                // Workflows are expected to be small; simple ready-node scanning keeps behavior easy to reason about.
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
                        // Condition false => mark node complete without creating a job.
                        completed.add(node.id);
                        madeProgress = true;
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
                    if (madeProgress) {
                        // Skips can make progress without creating runnable nodes in this pass.
                        continue;
                    }
                    // No ready nodes with unfinished graph implies unresolved dependency graph/deadlock.
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
                // Convert map to plain record before aggregate so callers get stable serializable input.
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

    /**
     * Executes a single node with retry and optional backoff.
     *
     * @param workflowId Parent workflow id
     * @param node Node definition
     * @param ctx Shared multimodal context
     * @param state Shared mutable state
     * @returns Step result payload
     * @throws {Error} When all attempts fail
     */
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

                // JobManager handles scheduling/lifecycle while node awaits completion promise.
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

    /**
     * Performs static workflow validation before execution.
     *
     * @param workflow Workflow definition to validate
     * @throws {Error} On duplicates, missing dependencies, or cycles
     */
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

    /**
     * Detects dependency cycles via DFS.
     *
     * @param workflow Workflow definition
     * @throws {Error} When a cycle is found
     */
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

    /**
     * Waits for a fixed number of milliseconds.
     *
     * @param ms Delay in milliseconds
     */
    private delay(ms: number): Promise<void> {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }

    /**
     * Returns a promise that rejects when timeout is reached.
     *
     * @param msTimeout Timeout duration in milliseconds
     * @throws {Error} Timeout error
     */
    private timeout(msTimeout: number): Promise<void> {
        return new Promise((_, reject) => {
            setTimeout(() => reject(new Error(`WorkflowRunner: node execution exceeded timeout of ${msTimeout}ms`)), msTimeout);
        });
    }
}
