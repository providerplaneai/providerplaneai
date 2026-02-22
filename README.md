# ProviderPlaneAI

A **provider-agnostic orchestration layer for multi-provider, multi-modal AI**.

ProviderPlaneAI enables applications and agents to access modern AI capabilities through a single, unified execution plane — without coupling business logic to any specific vendor SDK.

You code against **capabilities** (chat, streaming, embeddings, image generation, audio processing, moderation, etc.), not vendors. Providers explicitly declare supported capabilities, and the client orchestrates execution across providers with deterministic, configurable fallback behavior.

---

## Key Features

✨ **Provider-Agnostic Orchestration**

- Abstract away vendor-specific SDKs and APIs
- Switch providers without rewriting business logic
- Explicit, deterministic multi-provider fallback chains

🎯 **Capability-First Design**

- Capabilities are first-class concepts, not afterthoughts
- Providers explicitly declare what they support
- Fail fast and clearly when capabilities are unavailable

🔄 **Unified Streaming Model**

- Consistent `AsyncGenerator`-based streaming across all providers
- Automatic fallback mid-stream if a provider fails
- No vendor-specific streaming quirks

📊 **Session & Event Tracking**

- Built-in session management with full history
- Event-driven architecture for request/response tracking
- Session serialization for persistence and resumption

🛡️ **Type-Safe Request/Response Handling**

- Strongly-typed request and response objects
- Multi-modal execution contexts for complex operations
- Normalized response formats across providers

🚀 **Production-Ready**

- Configuration management (file-based + environment overrides)
- Lifecycle hooks for initialization and cleanup
- Comprehensive error handling and reporting
- Full test coverage with Vitest

---

## Supported Providers

### Currently Implemented

- **OpenAI** — Chat, streaming, embeddings, image generation, audio, moderation
- **Anthropic** — Chat, streaming, embeddings, image analysis
- **Google Gemini** — Chat, streaming, embeddings, image analysis, video analysis

Each provider registers its capabilities explicitly at initialization time.

---

## Core Concepts

### Capabilities

A capability represents a specific, orthogonal AI feature. Examples:

- `ChatCapability` — Single-turn chat completion
- `ChatStreamCapability` — Streaming chat responses
- `EmbedCapability` — Text embeddings
- `ImageGenerationCapability` — Image generation
- `ImageAnalysisCapability` — Image analysis and understanding
- `ModerationCapability` — Content moderation
- And more...

---

### Sessions

Sessions track conversation history and execution events for auditability, debugging, and stateful interactions:

```typescript
const session = client.createSession();
const snapshot = client.serializeSession(session.id);
// Later...
const restored = client.resumeSession(snapshot);
```

---

### Provider Chains

Routes requests through multiple providers with automatic fallback:

```typescript
// Use default chain from config
await client.chat(request, session);

// Or override with custom chain
await client.chat(request, session, [
  { providerType: "openai", connectionName: "default" },
  { providerType: "anthropic", connectionName: "default" }
]);
```

---

### Multi-Modal Execution Context

Rich context passed to providers for complex operations:

- Request metadata and configuration
- Session tracking and event emission
- Request/response logging
- Provider-specific parameters

---

## Installation & Setup

### Prerequisites

- Node.js 20+
- TypeScript 5.3+

### Installation

Install the latest version from npm:

```bash
npm install providerplaneai
```

---

## Configuration

Create a `config/default.json` file in your project root. Environment variables are automatically substituted from `process.env`.

```json
{
  "executionPolicy": {
    "providerChain": [
      { "providerType": "openai", "connectionName": "default" },
      { "providerType": "anthropic", "connectionName": "default" }
    ]
  },
  "providers": {
    "openai": {
      "default": {
        "apiKey": "${OPENAI_API_KEY}",
        "model": "gpt-4"
      }
    },
    "anthropic": {
      "default": {
        "apiKey": "${ANTHROPIC_API_KEY}",
        "model": "claude-3-sonnet"
      }
    },
    "gemini": {
      "default": {
        "apiKey": "${GEMINI_API_KEY}",
        "model": "gemini-pro"
      }
    }
  }
}
```

---

## Quick Start

```typescript
import { AIClient } from "providerplaneai";

const client = new AIClient();

// Create a session
const session = client.createSession();

// Make a request
const response = await client.chat(
  {
    input: {
      messages: [
        { role: "user", content: "Hello, how are you?" }
      ]
    }
  },
  session
);

console.log(response.output);
```

---

## Performance & Throughput

ProviderPlaneAI exposes explicit runtime limits so high-throughput behavior is predictable.

### Core Limits

- `appConfig.maxConcurrency`: max jobs executing at once (`0` disables execution).
- `appConfig.maxQueueSize`: max queued jobs waiting to execute.
- `appConfig.maxStoredResponseChunks`: max in-memory orchestration chunks retained per job.
- `appConfig.storeRawResponses`: whether raw provider payloads are retained for diagnostics.
- `appConfig.maxRawBytesPerJob`: byte budget for retained raw payloads per job.
- `appConfig.maxRemoteImageBytes`: byte cap when decoding/fetching reference images.
- `appConfig.remoteImageFetchTimeoutMs`: timeout for remote image fetch operations.

### Runtime Observability

Use `jobManager.getQueueLength()` and `jobManager.getRunningCount()` to monitor pressure in real time.

### High-Throughput Guidance

- Start with bounded queueing (`maxQueueSize`) to protect process memory under burst traffic.
- Keep `maxStoredResponseChunks` small for streaming-heavy workloads.
- Prefer `storeRawResponses: false` in production unless you need deep diagnostics.
- If raw payload diagnostics are needed, set a strict `maxRawBytesPerJob` budget.
- Monitor queue depth (`jobManager.getQueueLength()`) and running jobs (`jobManager.getRunningCount()`) to tune concurrency.

---

## API Overview

### AIClient Methods

#### Session Management

```typescript
createSession(id?: string): AISession
getSession(id: string): AISession | undefined
getOrCreateSession(id?: string): AISession
listSessions(): string[]
serializeSession(id: string): SessionSnapshot
resumeSession(snapshot: SessionSnapshot): AISession
closeSession(id: string): void
```

#### Chat Capabilities

```typescript
// Non-streaming chat
async chat(
  request: AIRequest<ClientChatRequest>,
  session: AISession,
  providerChain?: ProviderRef[]
): Promise<AIResponse<string[]>>

// Streaming chat
async *chatStream(
  request: AIRequest<ClientChatRequest>,
  session: AISession,
  providerChain?: ProviderRef[]
): AsyncGenerator<AIResponseChunk<string>>
```

#### Embeddings

```typescript
async embeddings(
  request: AIRequest<ClientEmbeddingRequest>,
  session: AISession,
  providerChain?: ProviderRef[]
): Promise<AIResponse<number[] | number[][]>>
```

#### Image Operations

```typescript
// Image generation
async generateImage(
  request: AIRequest<ClientImageGenerationRequest>,
  session: AISession,
  providerChain?: ProviderRef[]
): Promise<AIResponse<NormalizedImage[]>>

async *generateImageStream(
  request: AIRequest<ClientImageGenerationRequest>,
  session: AISession,
  providerChain?: ProviderRef[]
): AsyncGenerator<AIResponseChunk<NormalizedImage[]>>

// Image analysis
async analyzeImage(
  request: AIRequest<ClientImageAnalysisRequest>,
  session: AISession,
  providerChain?: ProviderRef[]
): Promise<AIResponse<NormalizedImageAnalysis[]>>

async *analyzeImageStream(
  request: AIRequest<ClientImageAnalysisRequest>,
  session: AISession,
  providerChain?: ProviderRef[]
): AsyncGenerator<AIResponseChunk<NormalizedImageAnalysis[]>>

// Image editing
async editImage(
  request: AIRequest<ClientImageEditRequest>,
  session: AISession,
  providerChain?: ProviderRef[]
): Promise<AIResponse<NormalizedImage[]>>

async *editImageStream(
  request: AIRequest<ClientImageEditRequest>,
  session: AISession,
  providerChain?: ProviderRef[]
): AsyncGenerator<AIResponseChunk<NormalizedImage[]>>
```

#### Moderation

```typescript
async moderation(
  request: AIRequest<ClientModerationRequest>,
  session: AISession,
  providerChain?: ProviderRef[]
): Promise<AIResponse<ModerationResult | ModerationResult[]>>
```

#### Provider Management

```typescript
registerProvider(
  provider: BaseProvider,
  providerType: AIProviderType,
  connectionName?: string
): void

getProvider<T extends BaseProvider>(
  type: AIProviderType,
  connectionName?: string
): T
```

---

## Request Structure

All requests follow a consistent structure:

```typescript
interface AIRequest<T> {
  input: T;
  metadata?: {
    requestId?: string;
    userId?: string;
    tags?: string[];
    [key: string]: any;
  };
}
```

---

## Response Structure

```typescript
interface AIResponse<T> {
  output: T;
  metadata?: {
    provider: AIProviderType;
    model?: string;
    tokensUsed?: number;
    executionTime?: number;
    [key: string]: any;
  };
}
```

---

## Error Handling

```typescript
import {
  AllProvidersFailedError,
  DuplicateProviderRegistrationError,
  ExecutionPolicyError
} from "providerplaneai";
```

---

## Architecture

### Design Principles

1. **Capability-Aware, Provider-Agnostic**
2. **Fail Fast and Explicitly**
3. **Thin Orchestration Layer, Thick Providers**
4. **Orthogonal Capabilities**
5. **Configuration-Driven Execution**

---

## License

MIT License
