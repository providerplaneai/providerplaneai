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
    retry?: WorkflowRetryPolicy;
    timeoutMs?: number;
}

export class WorkflowBuilder<TOutput = unknown> {
    private nodes: WorkflowNode[] = [];
    private aggregator?: (results: Record<string, unknown>, state: WorkflowState) => TOutput;

    constructor(private id: string) {}

    node(id: string, fn: WorkflowNodeFn, options?: WorkflowNodeOptions): this {
        if (this.nodes.some((n) => n.id === id)) {
            throw new Error(`WorkflowBuilder: duplicate node id '${id}'`);
        }

        this.nodes.push({
            id,
            run: fn,
            dependsOn: options?.dependsOn ?? [],
            retry: options?.retry,
            timeoutMs: options?.timeoutMs
        });

        return this;
    }

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

    aggregate(fn: (results: Record<string, unknown>, state: WorkflowState) => TOutput): this {
        this.aggregator = fn;
        return this;
    }

    build(): Workflow<TOutput> {
        return {
            id: this.id,
            nodes: [...this.nodes],
            aggregate: this.aggregator
        };
    }
}
