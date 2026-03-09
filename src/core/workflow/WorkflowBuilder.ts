import {
    AIClient,
    GenericJob,
    MultiModalExecutionContext,
    Workflow,
    WorkflowNode,
    WorkflowRetryPolicy,
    WorkflowState
} from "#root/index.js";

type WorkflowNodeFn = (ctx: MultiModalExecutionContext, client: AIClient, state: WorkflowState) => GenericJob<any, any>;

interface WorkflowNodeOptions {
    dependsOn?: string[];
    condition?: (state: WorkflowState) => boolean;
    retry?: WorkflowRetryPolicy;
    timeoutMs?: number;
}

/**
 * Fluent builder used to construct workflow DAG definitions.
 *
 * @typeParam TOutput Final aggregate output type
 */
export class WorkflowBuilder<TOutput = unknown> {
    private nodes: WorkflowNode[] = [];
    private aggregator?: (results: Record<string, unknown>, state: WorkflowState) => TOutput;

    /**
     * @param id Unique workflow ID
     */
    constructor(private id: string) {}

    /**
     * Adds a workflow node.
     *
     * @param id Unique node identifier
     * @param fn Node execution factory
     * @param options Optional node execution options
     * @returns Builder instance for chaining
     * @throws {Error} When node id is duplicated
     */
    node(id: string, fn: WorkflowNodeFn, options?: WorkflowNodeOptions): this {
        if (this.nodes.some((n) => n.id === id)) {
            throw new Error(`WorkflowBuilder: duplicate node id '${id}'`);
        }

        // Store node definition as plain data; execution behavior lives in WorkflowRunner.
        this.nodes.push({
            id,
            run: fn,
            dependsOn: options?.dependsOn ?? [],
            condition: options?.condition,
            retry: options?.retry,
            timeoutMs: options?.timeoutMs
        });

        return this;
    }

    /**
     * Adds a node with dependencies in a more readable way than manual `dependsOn`.
     *
     * @param dependencies One dependency id or list of dependency ids
     * @param id Unique node identifier
     * @param fn Node execution factory
     * @param options Additional node options (excluding dependsOn)
     * @returns Builder instance for chaining
     */
    after(
        dependencies: string | string[],
        id: string,
        fn: WorkflowNodeFn,
        options?: Omit<WorkflowNodeOptions, "dependsOn">
    ): this {
        const dependsOn = Array.isArray(dependencies) ? dependencies : [dependencies];

        return this.node(id, fn, {
            ...options,
            dependsOn
        });
    }

    /**
     * Registers a final aggregate mapper for workflow output.
     *
     * @param fn Aggregate function
     * @returns Builder instance for chaining
     */
    aggregate(fn: (results: Record<string, unknown>, state: WorkflowState) => TOutput): this {
        this.aggregator = fn;
        return this;
    }

    /**
     * Builds an immutable workflow definition snapshot.
     *
     * @returns Workflow definition
     */
    build(): Workflow<TOutput> {
        return {
            id: this.id,
            nodes: [...this.nodes],
            aggregate: this.aggregator
        };
    }
}
