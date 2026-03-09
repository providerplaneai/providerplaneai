import {
    AIClient,
    GenericJob,
    JobChunk,
    JobManager,
    MultiModalExecutionContext,
    Workflow,
    WorkflowDefaults,
    WorkflowExecution,
    WorkflowExecutionSnapshot,
    WORKFLOW_EXECUTION_SNAPSHOT_SCHEMA_VERSION,
    WorkflowNode,
    WorkflowState,
    WorkflowStepResult,
    WorkflowError
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
    /** Called for every streamed chunk emitted by a workflow node job. */
    onNodeChunk?: (workflowId: string, nodeId: string, chunk: JobChunk<any>) => void;
    /** Called when a node attempt fails but will be retried. */
    onNodeRetry?: (workflowId: string, nodeId: string, error: Error, attempt: number, maxAttempts: number) => void;
    /** Called when a node attempt fails and retries are exhausted. */
    onNodeError?: (workflowId: string, nodeId: string, error: Error, attempt: number, maxAttempts: number) => void;
}

/**
 * Optional persistence hooks for workflow execution snapshots.
 */
export interface WorkflowRunnerPersistence {
    /** Persist the current workflow snapshot (called incrementally during execution). */
    persistWorkflowExecution?: (snapshot: WorkflowExecutionSnapshot<any>) => void | Promise<void>;
    /** Load the latest snapshot for a workflow id. */
    loadWorkflowExecution?: (
        workflowId: string
    ) => WorkflowExecutionSnapshot<any> | undefined | Promise<WorkflowExecutionSnapshot<any> | undefined>;
}

/**
 * Constructor options for {@link WorkflowRunner}.
 */
export interface WorkflowRunnerOptions {
    /** Job manager used to schedule workflow node jobs. */
    jobManager: JobManager;
    /** AI client passed to node run callbacks. */
    client: AIClient;
    /** Optional workflow lifecycle hooks. */
    hooks?: WorkflowRunnerHooks;
    /** Optional persistence hooks for snapshots/resume. */
    persistence?: WorkflowRunnerPersistence;
}

/**
 * DAG workflow execution engine built on top of JobManager/GenericJob.
 */
export class WorkflowRunner {
    private readonly jobManager: JobManager;
    private readonly client: AIClient;
    private readonly hooks?: WorkflowRunnerHooks;
    private readonly persistence?: WorkflowRunnerPersistence;

    /**
     * @param jobManager Job scheduler used to run child jobs
     * @param client AIClient instance passed into workflow nodes
     * @param hooks Optional workflow lifecycle hooks
     */
    constructor(options: WorkflowRunnerOptions);
    constructor(jobManager: JobManager, client: AIClient, hooks?: WorkflowRunnerHooks, persistence?: WorkflowRunnerPersistence);
    constructor(
        jobManagerOrOptions: JobManager | WorkflowRunnerOptions,
        client?: AIClient,
        hooks?: WorkflowRunnerHooks,
        persistence?: WorkflowRunnerPersistence
    ) {
        if (client) {
            this.jobManager = jobManagerOrOptions as JobManager;
            this.client = client;
            this.hooks = hooks;
            this.persistence = persistence;
            return;
        }

        const options = jobManagerOrOptions as WorkflowRunnerOptions;
        this.jobManager = options.jobManager;
        this.client = options.client;
        this.hooks = options.hooks;
        this.persistence = options.persistence;
    }

    /**
     * Wraps a child workflow into a job so it can be used as a node output in a parent workflow.
     *
     * @typeParam TOutput Child workflow aggregate output type
     * @param workflow Child workflow definition
     * @param initialState Optional initial child workflow state
     * @returns Generic job whose final output is the child workflow aggregated output
     */
    createWorkflowJob<TOutput>(workflow: Workflow<TOutput>, initialState?: WorkflowState): GenericJob<void, TOutput> {
        const job = new GenericJob<void, TOutput>(undefined, false, async (_input, ctx, signal) => {
            // Child runner shares manager/client, but forwards chunks back through the parent runner hooks
            // with a namespaced node id so nested streams remain traceable.
            const childRunner = new WorkflowRunner({
                jobManager: this.jobManager,
                client: this.client,
                hooks: {
                    ...this.hooks,
                    onNodeChunk: (childWorkflowId, nodeId, chunk) => {
                        this.hooks?.onNodeChunk?.(childWorkflowId, `${workflow.id}.${nodeId}`, chunk);
                    }
                },
                persistence: this.persistence
            });

            const result = await childRunner.run(workflow, ctx, initialState, signal);

            return {
                output: result.output as TOutput,
                rawResponse: result,
                id: workflow.id,
                metadata: {
                    status: result.status
                }
            };
        });

        // WorkflowRunner executes all node jobs through JobManager.runJob(id, ...),
        // so nested workflow wrapper jobs must be registered before being returned.
        this.jobManager.addJob(job);
        return job;
    }

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
        initialState?: WorkflowState,
        signal?: AbortSignal
    ): Promise<WorkflowExecution<TOutput>> {
        return this.execute(workflow, ctx, undefined, initialState, signal);
    }

    /**
     * Resumes a workflow from the latest persisted snapshot.
     *
     * @typeParam TOutput Final aggregate output type
     * @param workflow Workflow definition
     * @param ctx Shared multimodal execution context
     * @param signal Optional abort signal
     */
    async resume<TOutput>(
        workflow: Workflow<TOutput>,
        ctx: MultiModalExecutionContext,
        signal?: AbortSignal
    ): Promise<WorkflowExecution<TOutput>> {
        if (!this.persistence?.loadWorkflowExecution) {
            throw new WorkflowError("WorkflowRunner: resume requires loadWorkflowExecution persistence hook");
        }
        const snapshot = await this.persistence.loadWorkflowExecution(workflow.id);
        if (!snapshot) {
            throw new WorkflowError(`WorkflowRunner: no persisted snapshot found for workflow '${workflow.id}'`);
        }
        return this.execute(workflow, ctx, snapshot as WorkflowExecutionSnapshot<TOutput>, undefined, signal);
    }

    private async execute<TOutput>(
        workflow: Workflow<TOutput>,
        ctx: MultiModalExecutionContext,
        resumeSnapshot?: WorkflowExecutionSnapshot<TOutput>,
        initialState?: WorkflowState,
        signal?: AbortSignal
    ): Promise<WorkflowExecution<TOutput>> {
        this.validateWorkflow(workflow);
        this.validateResumeSnapshot(workflow, resumeSnapshot);

        const state: WorkflowState = resumeSnapshot?.state ?? initialState ?? { values: {} };
        const startedAt = resumeSnapshot?.startedAt ?? Date.now();

        const execution: WorkflowExecution<TOutput> = {
            workflowId: workflow.id,
            status: "running",
            results: resumeSnapshot?.results ? [...resumeSnapshot.results] : [],
            state
        };

        const completed = new Set<string>(resumeSnapshot?.completedNodeIds ?? []);
        const running = new Set<string>();
        const resultsByNode = new Map<string, unknown>(
            (resumeSnapshot?.results ?? [])
                .filter((r) => r.outputs.length > 0)
                .map((r) => [r.stepId, r.outputs[0] as unknown] as const)
        );
        const nodeMap = new Map(workflow.nodes.map((node) => [node.id, node] as const));
        const orderedNodes = Array.from(nodeMap.values()).sort((a, b) => a.id.localeCompare(b.id));
        const activeJobIds = new Set<string>();
        const inFlightNodes = new Map<
            string,
            Promise<{
                nodeId: string;
            }>
        >();
        let aborted = false;

        const abortRunningJobs = () => {
            aborted = true;
            for (const jobId of activeJobIds) {
                try {
                    this.jobManager.abortJob(jobId, "Workflow aborted");
                } catch {
                    // Best effort: job may already be terminal.
                }
            }
        };

        const onAbort = () => {
            abortRunningJobs();
        };

        if (signal?.aborted) {
            abortRunningJobs();
            throw this.makeAbortError();
        }
        signal?.addEventListener("abort", onAbort);

        this.hooks?.onWorkflowStart?.(workflow.id);
        await this.persistExecutionSnapshot(execution, completed, startedAt, workflow.version);

        try {
            while (completed.size < nodeMap.size) {
                if (signal?.aborted || aborted) {
                    abortRunningJobs();
                    throw this.makeAbortError();
                }

                let madeProgress = false;

                // Continuously schedule newly-ready nodes so short branches are not blocked
                // by long-running siblings that happened to start in the same pass.
                for (const node of orderedNodes) {
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
                        await this.persistExecutionSnapshot(execution, completed, startedAt, workflow.version);

                        continue;
                    }

                    running.add(node.id);
                    this.hooks?.onNodeStart?.(workflow.id, node.id);
                    madeProgress = true;

                    const nodePromise = (async () => {
                        try {
                            const result = await this.runNodeWithRetry(
                                workflow.id,
                                node,
                                ctx,
                                state,
                                activeJobIds,
                                workflow.defaults,
                                signal
                            );
                            const output = result.outputs[0];

                            resultsByNode.set(node.id, output);
                            state.values[node.id] = output;

                            completed.add(node.id);

                            execution.results.push(result);
                            this.hooks?.onNodeComplete?.(workflow.id, node.id, result);
                            await this.persistExecutionSnapshot(execution, completed, startedAt, workflow.version);
                            return { nodeId: node.id };
                        } finally {
                            running.delete(node.id);
                            inFlightNodes.delete(node.id);
                        }
                    })();

                    inFlightNodes.set(node.id, nodePromise);
                }

                if (completed.size >= nodeMap.size) {
                    break;
                }

                if (inFlightNodes.size === 0) {
                    if (madeProgress) {
                        // Skips can make progress without creating runnable nodes in this pass.
                        continue;
                    }
                    // No ready nodes with unfinished graph implies unresolved dependency graph/deadlock.
                    throw new Error(
                        `WorkflowRunner: no runnable nodes found for workflow '${workflow.id}' (possible cycle, unresolved dependency, or deadlock)`
                    );
                }

                // Wait for at least one node to finish, then rescan immediately for newly-runnable work.
                await Promise.race(inFlightNodes.values());
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
            await this.persistExecutionSnapshot(execution, completed, startedAt, workflow.version);

            return execution;
        } catch (err) {
            if (inFlightNodes.size > 0) {
                // Avoid unhandled rejections from sibling in-flight nodes when one fails early.
                await Promise.allSettled(inFlightNodes.values());
            }
            const normalized = err instanceof Error ? err : new Error(String(err));
            const isAbort = signal?.aborted || aborted || this.isAbortError(normalized);
            execution.status = isAbort ? "aborted" : "error";
            if (!isAbort) {
                this.hooks?.onWorkflowError?.(workflow.id, normalized, execution);
            }
            await this.persistExecutionSnapshot(execution, completed, startedAt, workflow.version);
            throw normalized;
        } finally {
            signal?.removeEventListener("abort", onAbort);
        }
    }

    private async persistExecutionSnapshot<TOutput>(
        execution: WorkflowExecution<TOutput>,
        completed: Set<string>,
        startedAt: number,
        workflowVersion?: string | number
    ) {
        if (!this.persistence?.persistWorkflowExecution) {
            return;
        }
        const snapshot: WorkflowExecutionSnapshot<TOutput> = {
            schemaVersion: WORKFLOW_EXECUTION_SNAPSHOT_SCHEMA_VERSION,
            workflowId: execution.workflowId,
            workflowVersion,
            status: execution.status,
            completedNodeIds: Array.from(completed),
            results: execution.results,
            output: execution.output,
            state: execution.state,
            startedAt,
            updatedAt: Date.now()
        };
        await this.persistence.persistWorkflowExecution(snapshot);
    }

    private validateResumeSnapshot<TOutput>(workflow: Workflow<TOutput>, snapshot?: WorkflowExecutionSnapshot<TOutput>) {
        if (!snapshot) {
            return;
        }
        const schemaVersion = snapshot.schemaVersion ?? 1;
        if (schemaVersion !== WORKFLOW_EXECUTION_SNAPSHOT_SCHEMA_VERSION) {
            throw new WorkflowError(
                `WorkflowRunner: unsupported workflow snapshot schemaVersion '${schemaVersion}'. Expected '${WORKFLOW_EXECUTION_SNAPSHOT_SCHEMA_VERSION}'`
            );
        }
        if (snapshot.workflowId !== workflow.id) {
            throw new WorkflowError(
                `WorkflowRunner: snapshot workflowId '${snapshot.workflowId}' does not match workflow '${workflow.id}'`
            );
        }
        const snapshotWorkflowVersion = snapshot.workflowVersion;
        const currentWorkflowVersion = workflow.version;
        if (
            snapshotWorkflowVersion !== undefined &&
            currentWorkflowVersion !== undefined &&
            snapshotWorkflowVersion !== currentWorkflowVersion
        ) {
            throw new WorkflowError(
                `WorkflowRunner: snapshot workflowVersion '${snapshotWorkflowVersion}' does not match workflow version '${currentWorkflowVersion}'`
            );
        }
        const nodeIds = new Set(workflow.nodes.map((n) => n.id));
        for (const id of snapshot.completedNodeIds) {
            if (!nodeIds.has(id)) {
                throw new WorkflowError(`WorkflowRunner: snapshot contains unknown completed node '${id}'`);
            }
        }
        const completedSet = new Set(snapshot.completedNodeIds);
        for (const result of snapshot.results) {
            if (!nodeIds.has(result.stepId)) {
                throw new WorkflowError(`WorkflowRunner: snapshot contains unknown result node '${result.stepId}'`);
            }
            if (!completedSet.has(result.stepId)) {
                throw new WorkflowError(
                    `WorkflowRunner: snapshot result for node '${result.stepId}' is not present in completedNodeIds`
                );
            }
        }
        const nodeMap = new Map(workflow.nodes.map((n) => [n.id, n] as const));
        for (const completedNodeId of snapshot.completedNodeIds) {
            const node = nodeMap.get(completedNodeId);
            if (!node) {
                continue;
            }
            for (const dep of node.dependsOn ?? []) {
                if (!completedSet.has(dep)) {
                    throw new WorkflowError(
                        `WorkflowRunner: snapshot completed node '${completedNodeId}' is missing completed dependency '${dep}'`
                    );
                }
            }
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
        state: WorkflowState,
        activeJobIds: Set<string>,
        workflowDefaults?: WorkflowDefaults,
        signal?: AbortSignal
    ): Promise<WorkflowStepResult> {
        const retry = node.retry ?? workflowDefaults?.retry;
        const timeoutMs = node.timeoutMs ?? workflowDefaults?.timeoutMs;
        const maxAttempts = Math.max(retry?.attempts ?? 1, 1);
        const backoffMs = Math.max(retry?.backoffMs ?? 0, 0);

        let lastError: Error | undefined;

        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            if (signal?.aborted) {
                throw this.makeAbortError();
            }

            let jobId: string | undefined;
            let timeoutId: ReturnType<typeof setTimeout> | undefined;

            try {
                const startTime = Date.now();

                const job = node.run(ctx, this.client, this, state);
                jobId = job.id;
                activeJobIds.add(job.id);

                // JobManager handles scheduling/lifecycle while node awaits completion promise.
                this.jobManager.runJob(job.id, ctx, (chunk) => {
                    this.hooks?.onNodeChunk?.(workflowId, node.id, chunk);
                });

                const output = timeoutMs
                    ? await Promise.race([
                          job.getCompletionPromise(),
                          new Promise<never>((_, reject) => {
                              const timeoutError = new Error(
                                  `WorkflowRunner: node execution exceeded timeout of ${timeoutMs}ms`
                              );
                              timeoutError.name = "WorkflowNodeTimeoutError";
                              timeoutId = setTimeout(() => reject(timeoutError), timeoutMs);
                              // Do not keep Node.js alive solely because of timeout guards.
                              (timeoutId as any)?.unref?.();
                          })
                      ])
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

                if (jobId && (signal?.aborted || this.isTimeoutError(lastError))) {
                    try {
                        this.jobManager.abortJob(jobId, signal?.aborted ? "Workflow aborted" : "Workflow node timed out");
                    } catch {
                        // Best effort: job may already be terminal.
                    }
                }

                if (signal?.aborted || this.isAbortError(lastError)) {
                    throw this.makeAbortError();
                }

                if (attempt >= maxAttempts) {
                    this.hooks?.onNodeError?.(workflowId, node.id, lastError, attempt, maxAttempts);
                    throw lastError;
                }

                this.hooks?.onNodeRetry?.(workflowId, node.id, lastError, attempt, maxAttempts);

                if (backoffMs > 0) {
                    await this.delay(backoffMs);
                }
            } finally {
                if (timeoutId) {
                    clearTimeout(timeoutId);
                }
                if (jobId) {
                    activeJobIds.delete(jobId);
                }
            }
        }

        throw (
            lastError ??
            new WorkflowError(`WorkflowRunner: node '${node.id}' in workflow '${workflowId}' failed unexpectedly without error`)
        );
    }

    /**
     * Performs static workflow validation before execution.
     *
     * @param workflow Workflow definition to validate
     * @throws {WorkflowError} On duplicates, missing dependencies, or cycles
     */
    private validateWorkflow(workflow: Workflow<any>) {
        const ids = new Set<string>();

        for (const node of workflow.nodes) {
            if (ids.has(node.id)) {
                throw new WorkflowError(`WorkflowRunner: duplicate node id '${node.id}'`);
            }
            ids.add(node.id);
        }

        for (const node of workflow.nodes) {
            for (const dep of node.dependsOn ?? []) {
                if (!ids.has(dep)) {
                    throw new WorkflowError(`WorkflowRunner: node '${node.id}' depends on unknown node '${dep}'`);
                }
            }
        }

        this.validateNoCycles(workflow);
    }

    /**
     * Detects dependency cycles via DFS.
     *
     * @param workflow Workflow definition
     * @throws {WorkflowError} When a cycle is found
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
                throw new WorkflowError(`WorkflowRunner: cycle detected at node '${nodeId}'`);
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

    private isTimeoutError(error: Error): boolean {
        return error.name === "WorkflowNodeTimeoutError";
    }

    private makeAbortError(): WorkflowError {
        const abortError = new WorkflowError("Workflow aborted");
        abortError.name = "AbortError";
        return abortError;
    }

    private isAbortError(error: Error): boolean {
        return error.name === "AbortError";
    }
}
