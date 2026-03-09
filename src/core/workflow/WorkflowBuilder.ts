/**
 * @module core/workflow/WorkflowBuilder.ts
 * @description ProviderPlaneAI source module.
 */
import {
    AIClient,
    AIRequest,
    CapabilityKeyType,
    GenericJob,
    MultiModalExecutionContext,
    ProviderRef,
    Workflow,
    WorkflowNode,
    WorkflowRunner,
    WorkflowDefaults,
    WorkflowRetryPolicy,
    WorkflowState,
    WorkflowError
} from "#root/index.js";

type WorkflowNodeFn = (
    ctx: MultiModalExecutionContext,
    client: AIClient,
    runner: WorkflowRunner,
    state: WorkflowState
) => GenericJob<any, any>;

/**
 * Builder-time options for an individual workflow node.
 *
 * @internal
 */
interface WorkflowNodeOptions {
    dependsOn?: string[];
    condition?: (state: WorkflowState) => boolean;
    retry?: WorkflowRetryPolicy;
    timeoutMs?: number;
}

/**
 * Builder-time options for capability-backed node helpers.
 *
 * @internal
 */
type WorkflowCapabilityNodeOptions = WorkflowNodeOptions & {
    providerChain?: ProviderRef[];
    addToManager?: boolean;
};

/**
 * Static request payload or lazy request factory used by capability helpers.
 *
 * @typeParam TInput Capability request input type
 * @internal
 */
type WorkflowCapabilityRequestFactory<TInput> =
    | AIRequest<TInput>
    | ((ctx: MultiModalExecutionContext, state: WorkflowState) => AIRequest<TInput>);

/**
 * Builder used to construct workflow DAG definitions.
 *
 * @typeParam TOutput Final aggregate output type
 */
export class WorkflowBuilder<TOutput = unknown> {
    /**
     * Optional version stamp used for resume compatibility checks.
     */
    private workflowVersion?: string | number;
    /**
     * Node definitions collected in insertion order.
     */
    private nodes: WorkflowNode[] = [];
    /**
     * Workflow-level default execution policies.
     */
    private defaultPolicies: WorkflowDefaults = {};
    /**
     * Optional workflow aggregate projection.
     */
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
     * @throws {WorkflowError} When node id is duplicated
     */
    node(id: string, fn: WorkflowNodeFn, options?: WorkflowNodeOptions): this {
        if (this.nodes.some((n) => n.id === id)) {
            throw new WorkflowError(`WorkflowBuilder: duplicate node id '${id}'`);
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
     * @throws {WorkflowError} When node id is duplicated
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
     * Sets workflow-level default policies used by runner and capability helpers.
     * Calling this multiple times merges values (latest wins per field).
     *
     * @param defaults Default policy values
     * @returns Builder instance for chaining
     */
    defaults(defaults: WorkflowDefaults): this {
        this.defaultPolicies = {
            ...this.defaultPolicies,
            ...defaults
        };
        return this;
    }

    /**
     * Sets a workflow version identifier used by resume drift checks.
     *
     * @param value Version value
     * @returns Builder instance for chaining
     */
    version(value: string | number): this {
        this.workflowVersion = value;
        return this;
    }

    /**
     * Adds a capability-backed node without writing the boilerplate `client.createCapabilityJob(...)` call.
     *
     * @typeParam C Capability key
     * @typeParam TInput Capability request input type
     * @typeParam TOutput Capability output type
     * @param id Unique node identifier
     * @param capability Capability key to execute
     * @param requestOrFactory Static request or state-aware request factory
     * @param options Optional node + capability-job options
     * @returns Builder instance for chaining
     * @throws {WorkflowError} When node id is duplicated
     */
    capabilityNode<C extends CapabilityKeyType, TInput, TOutput>(
        id: string,
        capability: C,
        requestOrFactory: WorkflowCapabilityRequestFactory<TInput>,
        options?: WorkflowCapabilityNodeOptions
    ): this {
        const { providerChain, addToManager, ...nodeOptions } = options ?? {};
        const resolvedProviderChain = providerChain ?? this.defaultPolicies.providerChain;
        const resolvedAddToManager = addToManager ?? this.defaultPolicies.addToManager;

        return this.node(
            id,
            (ctx, client, _runner, state) =>
                client.createCapabilityJob<C, TInput, TOutput>(
                    capability,
                    typeof requestOrFactory === "function" ? requestOrFactory(ctx, state) : requestOrFactory,
                    {
                        providerChain: resolvedProviderChain,
                        addToManager: resolvedAddToManager
                    }
                ),
            nodeOptions
        );
    }

    /**
     * Adds a capability-backed node with dependencies.
     *
     * @typeParam C Capability key
     * @typeParam TInput Capability request input type
     * @typeParam TOutput Capability output type
     * @param dependencies One dependency id or list of dependency ids
     * @param id Unique node identifier
     * @param capability Capability key to execute
     * @param requestOrFactory Static request or state-aware request factory
     * @param options Optional node + capability-job options
     * @returns Builder instance for chaining
     * @throws {WorkflowError} When node id is duplicated
     */
    capabilityAfter<C extends CapabilityKeyType, TInput, TOutput>(
        dependencies: string | string[],
        id: string,
        capability: C,
        requestOrFactory: WorkflowCapabilityRequestFactory<TInput>,
        options?: Omit<WorkflowCapabilityNodeOptions, "dependsOn">
    ): this {
        const dependsOn = Array.isArray(dependencies) ? dependencies : [dependencies];
        return this.capabilityNode<C, TInput, TOutput>(id, capability, requestOrFactory, {
            ...(options ?? {}),
            dependsOn
        });
    }

    /**
     * Builds an immutable workflow definition snapshot.
     *
     * @returns Workflow definition
     */
    build(): Workflow<TOutput> {
        // Return cloned collections so subsequent builder mutations do not alter
        // already-built workflow definitions.
        return {
            id: this.id,
            ...(this.workflowVersion !== undefined ? { version: this.workflowVersion } : {}),
            nodes: [...this.nodes],
            defaults: { ...this.defaultPolicies },
            aggregate: this.aggregator
        };
    }
}
