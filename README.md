# ProviderPlaneAI

[![npm version](https://img.shields.io/npm/v/providerplaneai)](https://www.npmjs.com/package/providerplaneai)
[![npm downloads](https://img.shields.io/npm/dm/providerplaneai)](https://www.npmjs.com/package/providerplaneai)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![CI](https://img.shields.io/github/actions/workflow/status/providerplaneai/providerplaneai/node.js.yml?branch=main)](https://github.com/providerplaneai/providerplaneai/actions)
[![TypeDocs](https://img.shields.io/badge/docs-typedoc-blue)](https://www.providerplane.dev)

**ProviderPlaneAI** is a workflow-first, provider-agnostic AI orchestration framework designed for building scalable, resilient, and observable AI applications.

It focuses on modern AI system challenges such as streaming, multimodal pipelines, fallback strategies, execution tracing, and asynchronous workflows while remaining extensible and production-ready.

API documentation: [www.providerplane.dev](https://www.providerplane.dev)

## Table of Contents

- [Key Concepts](#key-concepts)
- [Core Features](#core-features)
- [Example Use Cases](#example-use-cases)
- [Getting Started](#getting-started)
- [Built-In Providers](#built-in-providers)
- [Design Goals](#design-goals)
- [Workflow System](#workflow-system)
- [Development](#development)
- [Open Source and Contributions](#open-source-and-contributions)
- [License](#license)

---

<a id="key-concepts"></a>
## Key Concepts 🧠

### Workflow-First Architecture 🧩

ProviderPlaneAI treats workflows as the primary API and jobs as the execution substrate (middle layer). This enables:
- High-level DAG orchestration as the default developer experience
- Asynchronous and synchronous execution
- Retry, rerun, and persistence support
- Concurrency and queue control
- Observability and lifecycle tracking
- Streaming and non-streaming execution under a unified model

### Capability-Based Design 🔌

Instead of tying your system to specific vendors, ProviderPlaneAI routes requests through **capabilities**, allowing:
- Provider-agnostic execution
- Clean abstraction and extensibility
- Custom capability integration
- Easy fallback across providers

### Streaming and Multimodal Pipelines 🌊

The framework natively supports:
- Streaming responses
- Incremental artifact generation
- Multimodal workflows (text, images, embeddings, moderation, analysis)
- Unified execution context and timeline tracking

### Resilience and Fallback 🛡️

Execution policies allow:
- Automatic fallback across providers
- Structured error handling
- Robust distributed AI pipelines

### Observability and Tracing 🔍

ProviderPlaneAI is designed with observability in mind:
- Execution metadata
- Structured job snapshots
- Streaming diagnostics
- Timeline-based artifact tracking

---

<a id="core-features"></a>
## Core Features ✨

- Provider-agnostic AI orchestration
- Workflow-first orchestration model (with jobs as internal/advanced layer)
- Streaming and non-streaming support
- Multimodal artifact pipelines
- Execution policies and fallback
- Observability and metadata tracking
- Extensible capability system
- Strong TypeScript typing
- Cloud and platform-friendly architecture
- OSS-friendly and framework-agnostic

---

<a id="example-use-cases"></a>
## Example Use Cases 🏗️

- AI platform and infrastructure teams
- Agent orchestration systems
- AI product backends
- Multimodal pipelines
- Distributed and resilient AI services
- Internal AI developer platforms

---

<a id="getting-started"></a>
## Getting Started 🚀

### Install 📦

```bash
npm install providerplaneai
```

### Runtime Requirements ✅

- Node.js 20+
- TypeScript 5+

### Configure Providers ⚙️

ProviderPlaneAI loads configuration via `node-config` + `dotenv`.

Create `config/default.json` (or environment-specific config files) with `appConfig` and `providers`.

Minimal example:

```json
{
  "appConfig": {
    "maxConcurrency": 128,
    "maxQueueSize": 1024,
    "maxStoredResponseChunks": 1024,
    "storeRawResponses": true,
    "maxRawBytesPerJob": 1048576,
    "remoteImageFetchTimeoutMs": 16384,
    "maxRemoteImageBytes": 10485760,
    "executionPolicy": {
      "providerChain": [
        { "providerType": "openai", "connectionName": "default" },
        { "providerType": "gemini", "connectionName": "default" },
        { "providerType": "anthropic", "connectionName": "default" }
      ]
    }
  },
  "providers": {
    "openai": {
      "default": {
        "type": "openai",
        "apiKeyEnvVar": "OPENAI_API_KEY_1",
        "defaultModel": "gpt-5",
        "defaultModels": { "chat": "gpt-5" },
        "providerDefaults": { "providerParams": {} },
        "models": {
          "gpt-5": {
            "chat": {
              "modelParams": {},
              "providerParams": {},
              "generalParams": {}
            },
            "chatStream": {
              "modelParams": {},
              "providerParams": {},
              "generalParams": { "chatStreamBatchSize": 64 }
            }
          }
        }
      }
    }
  }
}
```

Set environment variables referenced by `apiKeyEnvVar` (for example `OPENAI_API_KEY_1`, `GEMINI_API_KEY_1`, `ANTHROPIC_API_KEY_1`).

### Basic Usage (Workflow-First) 💡

```ts
import {
  AIClient,
  CapabilityKeys,
  MultiModalExecutionContext,
  WorkflowBuilder,
  WorkflowRunner
} from "providerplaneai";

const client = new AIClient();
const runner = new WorkflowRunner({ jobManager: client.jobManager, client });

const workflow = new WorkflowBuilder<{ text: string }>("quickstart-workflow")
  .capabilityNode("ask", CapabilityKeys.ChatCapabilityKey, {
    input: {
      messages: [{ role: "user", content: [{ type: "text", text: "Say hello in one sentence." }] }]
    }
  })
  .aggregate((results) => ({ text: String(results.ask) }))
  .build();

const execution = await runner.run(workflow, new MultiModalExecutionContext());
console.log(execution.output?.text);
```

### Advanced Usage (Direct Job API) ⚙️
Use direct jobs when you need fine-grained low-level control outside a workflow DAG.

```ts
import {
  AIClient,
  CapabilityKeys,
  MultiModalExecutionContext,
  type ClientChatRequest,
  type NormalizedChatMessage
} from "providerplaneai";

const client = new AIClient();

const request: ClientChatRequest = {
  messages: [
    {
      role: "user",
      content: [{ type: "text", text: "Hello" }]
    }
  ]
};

const job = client.createCapabilityJob<
  typeof CapabilityKeys.ChatCapabilityKey,
  ClientChatRequest,
  NormalizedChatMessage
>(CapabilityKeys.ChatCapabilityKey, { input: request });

const ctx = new MultiModalExecutionContext();
client.jobManager.runJob(job.id, ctx);

const result = await job.getCompletionPromise();
console.log(result);
```

### Streaming Usage 📡

```ts
import {
  AIClient,
  CapabilityKeys,
  MultiModalExecutionContext,
  type ClientChatRequest,
  type JobChunk,
  type NormalizedChatMessage
} from "providerplaneai";

const client = new AIClient();

const request: ClientChatRequest = {
  messages: [
    {
      role: "user",
      content: [{ type: "text", text: "Stream this response" }]
    }
  ]
};

const job = client.createCapabilityJob<
  typeof CapabilityKeys.ChatStreamCapabilityKey,
  ClientChatRequest,
  NormalizedChatMessage
>(CapabilityKeys.ChatStreamCapabilityKey, { input: request });

const ctx = new MultiModalExecutionContext();
client.jobManager.runJob(job.id, ctx, (chunk: JobChunk<NormalizedChatMessage>) => {
  if (chunk.delta?.content?.[0]?.type === "text") {
    process.stdout.write(chunk.delta.content[0].text);
  }
});

await job.getCompletionPromise();
```

---

<a id="built-in-providers"></a>
## Built-In Providers 🤝

#### Current providers:
- OpenAI
- Anthropic
- Gemini

Additional providers will be added in the future.

Providers are auto-registered from `appConfig.executionPolicy.providerChain` during `AIClient` construction.

---

<a id="design-goals"></a>
## Design Goals 🎯

ProviderPlaneAI is built around several guiding principles:

- **Abstraction without loss of control**
- **Streaming-first and multimodal-ready**
- **Resilient distributed execution**
- **Clear observability and traceability**
- **Extensibility and long-term maintainability**
- **Production-focused architecture**

---

<a id="workflow-system"></a>
## Workflow System

ProviderPlaneAI includes a DAG workflow engine on top of the job system.

### Workflow capabilities

- Deterministic DAG execution with explicit dependencies
- Parallel fan-out and fan-in aggregation
- Conditional step execution (`condition`)
- Per-node retry and timeout policies
- Provider-chain override per workflow step
- Streaming node support with workflow-level chunk hooks
- Nested workflows
- Persistence + resume support
- Export to JSON, Mermaid, DOT, and D3 graph formats

### Core APIs

- `WorkflowBuilder` (`src/core/workflow/WorkflowBuilder.ts`)
- `WorkflowRunner` (`src/core/workflow/WorkflowRunner.ts`)
- `WorkflowExporter` (`src/core/workflow/WorkflowExporter.ts`)

### Quick example

```ts
import {
  AIClient,
  CapabilityKeys,
  MultiModalExecutionContext,
  WorkflowBuilder,
  WorkflowRunner
} from "providerplaneai";

const client = new AIClient();
const runner = new WorkflowRunner({
  jobManager: client.jobManager,
  client,
  hooks: {
    onNodeChunk: (_workflowId, nodeId, chunk) => {
      if (typeof chunk.delta === "string") {
        process.stdout.write(`[${nodeId}] ${chunk.delta}`);
      }
    }
  }
});

const workflow = new WorkflowBuilder<{ finalText: string }>("example-workflow")
  .defaults({
    retry: { attempts: 2, backoffMs: 250 },
    timeoutMs: 45000
  })
  .capabilityNode(
    "draft",
    CapabilityKeys.ChatStreamCapabilityKey,
    {
      input: {
        messages: [{ role: "user", content: [{ type: "text", text: "Write one sentence about workflow reliability." }] }]
      },
      options: { model: "gpt-4.1" }
    },
    {
      providerChain: [
        { providerType: "openai", connectionName: "default" },
        { providerType: "gemini", connectionName: "default" }
      ]
    }
  )
  .capabilityAfter(
    "draft",
    "moderate",
    CapabilityKeys.ModerationCapabilityKey,
    (_ctx, state) => ({
      input: { text: String(state.values.draft) }
    })
  )
  .after(
    "moderate",
    "approval",
    (_ctx, nodeClient) =>
      nodeClient.createCapabilityJob(CapabilityKeys.ApprovalGateCapabilityKey, {
        input: { requestedAt: new Date().toISOString(), decision: { status: "approved", approver: "system" } }
      })
  )
  .aggregate((results) => ({
    finalText: String(results.draft)
  }))
  .build();

const execution = await runner.run(workflow, new MultiModalExecutionContext());
console.log(execution.status, execution.output);
```

### Built-in workflow-oriented capabilities

- `approvalGate` (`CapabilityKeys.ApprovalGateCapabilityKey`)
- `saveFile` (`CapabilityKeys.SaveFileCapabilityKey`)

These are registered by default in the capability executor registry.

### Workflow export

```ts
import { WorkflowExporter } from "providerplaneai";

const json = WorkflowExporter.workflowAsJSON(workflow);
const mermaid = WorkflowExporter.workflowAsMermaid(workflow);
const dot = WorkflowExporter.workflowAsDOT(workflow);
const d3 = WorkflowExporter.workflowAsD3(workflow);

// or via unified format selector
const anyFormat = WorkflowExporter.export(workflow, "mermaid");

// and optionally write to disk
await WorkflowExporter.exportToFile(workflow, "mermaid", "./test_data/workflows/example.mermaid");
```

### Example Workflow

```mermaid
graph TD
    n0["seedBrief"]
    n1["geminiAngles"]
    n2["anthropicRisks"]
    n3["seedTts"]
    n4["transcribeAudio"]
    n5["translateAudio"]
    n6["moderateTranscript"]
    n7["embedTranslation"]
    n8["imagePrompt"]
    n9["generateImage"]
    n10["analyzeImageAnthropic"]
    n11["unsafeEscalation"]
    n12["safeContinue"]
    n13["streamSynthesis"]
    n14["finalNarrationTts"]
    n15["saveFinalNarrationAudio"]
    n0 --> n1
    n0 --> n2
    n0 --> n3
    n3 --> n4
    n3 --> n5
    n4 --> n6
    n5 --> n7
    n1 --> n8
    n2 --> n8
    n8 --> n9
    n9 --> n10
    n6 --> n11
    n6 --> n12
    n1 --> n13
    n2 --> n13
    n4 --> n13
    n5 --> n13
    n6 --> n13
    n7 --> n13
    n10 --> n13
    n13 --> n14
    n14 --> n15
```

### Integration testing

- Deterministic integration tests:
  - `npm run test:integration`
- Provider-backed live integration tests:
  - `RUN_WORKFLOW_LIVE_INTEGRATION=1 npm run test:integration:live`
  - requires `OPENAI_API_KEY_1`, `GEMINI_API_KEY_1`, and `ANTHROPIC_API_KEY_1`

---

<a id="development"></a>
## Development 🛠️

```bash
npm run build
npm run test
npm run lint
```

### Git Hooks 🪝
We use Husky to enforce linting and tests.
Please do not bypass hooks unless absolutely necessary.

---

<a id="open-source-and-contributions"></a>
## Open Source and Contributions 🌍

ProviderPlaneAI is open source and designed to support real-world engineering teams. Contributions, feedback, and discussion are welcome.

If you are interested in contributing or collaborating, feel free to open an issue or discussion.

---

<a id="license"></a>
## License 📄

MIT
