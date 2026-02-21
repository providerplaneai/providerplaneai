# Type-Safety Checklist (Executors + Jobs)

Use this checklist before merging capability, job, or executor changes.

## 1) Core Generic Alignment

- [ ] Capability key `C` maps to the correct capability interface in `CapabilityMap[C]`.
- [ ] `AIRequest<TInput>` input type matches capability method signatures.
- [ ] Non-streaming outputs and streaming chunk outputs use the same domain type `TOutput`.
- [ ] No `any` is introduced where a concrete generic can be inferred.

## 2) Executor Contract Consistency (`src/core/provider/CapabilityExecutorRegistry.ts`)

- [ ] `StreamingExecutor` returns `AsyncGenerator<AIResponseChunk<TOutput>>`.
- [ ] `NonStreamingExecutor` return type is consistent with the rest of the pipeline.
- [ ] Registry `register/get/set` signatures preserve `C`, `TInput`, `TOutput` without lossy casts.
- [ ] Default executors return exactly what AIClient expects.

## 3) AIClient Execution Contracts (`src/client/AIClient.ts`)

- [ ] `executeWithPolicy()` return type and executor non-streaming return type match exactly.
- [ ] `createCapabilityJob()` does not assume `result.output` unless `result` is `AIResponse<TOutput>`.
- [ ] Stream and non-stream branches produce the same final `TOutput` shape.
- [ ] `applyOutputToContext()` casts only after capability narrowing.

## 4) Job Contract Consistency (`src/core/types/jobs/*`)

- [ ] `GenericJob.executor` return type matches the value assigned to `job.response` and `job.output`.
- [ ] `JobLifecycleHooks.onComplete` payload type matches actual value passed.
- [ ] `JobChunk<TOutput>` uses `delta`/`final` with the same `TOutput` type.
- [ ] `JobFactory` executor signature matches `GenericJob` executor signature.

## 5) Snapshot + Persistence Safety

- [ ] `JobSnapshot<TInput, TOutput>` round-trips without type widening.
- [ ] Restored jobs keep `input`, `output`, and `streaming` metadata types intact.
- [ ] Persist/load hooks avoid `unknown` to `any` casts unless validated.
- [ ] Error serialization/deserialization preserves expected shape.

## 6) API Surface Hygiene

- [ ] Public methods avoid generic defaults of `any` unless intentional.
- [ ] Internal escape hatches (`as any`) are isolated and documented.
- [ ] Overloads are ordered so TypeScript picks the most specific signature first.
- [ ] No duplicate switch cases or unreachable branches in capability routing.

## 7) Compiler + Tests as Gates

- [ ] `tsc --noEmit` passes with `strict` settings used by the repo.
- [ ] Add negative type tests for wrong capability/input pairing.
- [ ] Add regression tests for executor return type drift.
- [ ] Verify stream/non-stream job creation compiles without casts at call sites.

## 8) Immediate Hotspots in Current Codebase

- [ ] Reconcile non-streaming executor return type with `executeWithPolicy()` expectations.
- [ ] Reconcile `GenericJob` executor return type with stored `AIResponse<TOutput>` and `output` assignment.
- [ ] Ensure `JobLifecycleHooks.onComplete` receives the intended type (`TOutput` vs `AIResponse<TOutput>`).
- [ ] Audit duplicate capability cases in `AIClient.applyOutputToContext()` and keep one canonical branch.