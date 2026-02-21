# Streaming Debugging Checklist

Use this when a streaming job stalls, drops chunks, duplicates artifacts, or fails over unexpectedly.

## 1) Repro Setup

- [ ] Reproduce with a single capability and fixed provider chain.
- [ ] Capture `job.id`, capability key, provider chain order, and connection names.
- [ ] Attach `AIClientLifecycleHooks` to record attempt/chunk timing.
- [ ] Run once with fallback enabled and once with a single provider to isolate fallback behavior.

## 2) Entry-Point Validation (`src/client/AIClient.ts`)

- [ ] Confirm the streaming capability key is used (for example `ChatStreamCapabilityKey`, not `ChatCapabilityKey`).
- [ ] Verify `createCapabilityJob()` resolves an executor where `executor.streaming === true`.
- [ ] Confirm `executeWithPolicyStream()` is reached instead of `executeWithPolicy()`.
- [ ] Ensure `context.beginTurn()` runs exactly once per request.

## 3) Chunk Contract Checks (`src/core/types/AIResponse.ts`)

- [ ] Every emitted chunk has `done` set correctly.
- [ ] Non-final chunks only carry incremental `delta` unless intentionally sending full `output`.
- [ ] Final chunk includes complete `output` exactly once.
- [ ] Errors are surfaced through `chunk.error` and stop that provider attempt.

## 4) Job Chunk Mapping (`src/core/types/jobs/GenericJob.ts`)

- [ ] `onChunk({ delta })` is emitted for incremental updates.
- [ ] `onChunk({ final })` is emitted once when final output is known.
- [ ] `chunksEmitted`, `streamingStarted`, and `streamingCompleted` move consistently.
- [ ] Job status transitions `pending -> running -> completed|error|aborted` are preserved under stream errors.

## 5) Artifact Integrity (`src/client/AIClient.ts`, `src/core/types/jobs/GenericJob.ts`)

- [ ] Chunk-level `multimodalArtifacts` are passed through `ctx.yieldArtifacts(...)`.
- [ ] `syncArtifactsFromTimeline()` advances `timelineIndexCursor` and avoids double-appends.
- [ ] `applyOutputToContext()` does not double-attach artifacts for stream capabilities.
- [ ] Snapshot `multimodalArtifacts` matches timeline artifacts after completion.

## 6) Fallback + Failure Behavior (`src/client/AIClient.ts`)

- [ ] Mid-stream provider error triggers next provider attempt.
- [ ] Previously emitted chunks are not replayed after fallback (expected behavior).
- [ ] `onAttemptFailure` and `onExecutionFailure` hooks include timing + provider details.
- [ ] `AllProvidersFailedError` includes all attempt failures and chain metadata.

## 7) Abort + Timeout

- [ ] Caller abort propagates through `createExecutionSignal()`.
- [ ] Timeout abort (`timeoutMs`) produces deterministic error path.
- [ ] Job status resolves to `aborted` when cancelled.
- [ ] Timers are cleared on early abort.

## 8) Observability Minimum

- [ ] Log per chunk: provider, connection, chunk index, elapsed ms.
- [ ] Log fallback boundaries (provider switch points).
- [ ] Persist final `JobSnapshot` for post-mortem replay.
- [ ] Keep one known-good fixture stream for regression checks.

## 9) High-Value Tests to Add or Re-run

- [ ] Stream emits multiple deltas then final.
- [ ] Stream fails mid-way and falls back to next provider.
- [ ] Stream abort before first chunk.
- [ ] Stream timeout during emission.
- [ ] Artifacts from streamed chunks are present in final snapshot.