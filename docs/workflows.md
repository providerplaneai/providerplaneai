# Workflows

ProviderPlaneAI includes a DAG workflow layer on top of `AIClient` + `JobManager`.

## Core Concepts

- `WorkflowBuilder` defines nodes and dependencies.
- `WorkflowRunner` executes nodes in dependency order, with parallel batches when possible.
- `WorkflowState` is shared mutable state across nodes (`state.values`).
- Nodes return `GenericJob` instances (capability jobs or nested workflow jobs).

## Basic Usage

```ts
const workflow = new WorkflowBuilder("simple")
  .node("a", (_ctx, client) =>
    client.createCapabilityJob("customEcho", { input: { value: "hello" } })
  )
  .after("a", "b", (_ctx, client, _runner, state) =>
    client.createCapabilityJob("customEcho", { input: { value: `${String(state.values.a)}-world` } })
  )
  .aggregate((results) => ({ a: results.a, b: results.b }))
  .build();

const runner = new WorkflowRunner({
  jobManager: client.jobManager,
  client
});
const execution = await runner.run(workflow, ctx);
```

## Workflow Defaults

You can define workflow-level defaults and use capability helper nodes:

```ts
const workflow = new WorkflowBuilder("defaults-demo")
  .defaults({
    providerChain: [{ providerType: "openai", connectionName: "default" }],
    retry: { attempts: 2, backoffMs: 50 },
    timeoutMs: 15000
  })
  .capabilityNode("ask", CapabilityKeys.ChatCapabilityKey, {
    input: { messages: [{ role: "user", content: [{ type: "text", text: "Hi" }] }] }
  })
  .build();
```

Node-level `retry` / `timeoutMs` always override workflow defaults.

## Streaming Hooks

Use runner hooks for observability:

- `onNodeStart`
- `onNodeComplete`
- `onNodeChunk`
- `onNodeRetry`
- `onNodeError`

```ts
const runner = new WorkflowRunner({
  jobManager: client.jobManager,
  client,
  hooks: {
    onNodeChunk(workflowId, nodeId, chunk) {
      if (chunk.delta) {
        console.log(workflowId, nodeId, chunk.delta);
      }
    }
  }
});
```

## Nested Workflows

Inside a node, use the runner argument:

```ts
.node("nested", (_ctx, _client, runner) => runner.createWorkflowJob(childWorkflow))
```

Nested chunk events are forwarded via `onNodeChunk`.

## Cancellation

`WorkflowRunner.run(...)` accepts an optional `AbortSignal`.

```ts
const controller = new AbortController();
const runPromise = runner.run(workflow, ctx, undefined, controller.signal);
controller.abort();
await runPromise; // rejects with AbortError
```

Running node jobs are aborted through `JobManager.abortJob(...)`.

## Persistence and Resume

`WorkflowRunner` supports incremental persistence with snapshot hooks:

```ts
const snapshots = new Map<string, WorkflowExecutionSnapshot<any>>();

const runner = new WorkflowRunner({
  jobManager: client.jobManager,
  client,
  persistence: {
    persistWorkflowExecution: async (snapshot) => snapshots.set(snapshot.workflowId, snapshot),
    loadWorkflowExecution: async (workflowId) => snapshots.get(workflowId)
  }
});
```

- `runner.run(...)` persists snapshots during execution.
- `runner.resume(...)` resumes from the last snapshot for the workflow ID.

## Snapshot Compatibility

Snapshots include:

- `schemaVersion` (`WORKFLOW_EXECUTION_SNAPSHOT_SCHEMA_VERSION`)
- optional `workflowVersion` (from `WorkflowBuilder.version(...)`)

Resume validates:

- schema version compatibility
- workflow ID match
- node IDs in snapshot still exist
- completed-node dependency consistency
- optional workflow version match

If validation fails, resume throws a descriptive error.

## Running Workflow Tests

Workflow runtime tests are included in the standard test suite and can also be run directly:

```bash
npm run test:workflow
```
