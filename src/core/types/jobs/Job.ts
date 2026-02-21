import { MultiModalExecutionContext } from "#root/index.js";

export type JobStatus = "pending" | "running" | "completed" | "error" | "aborted" | "interrupted";

/**
 * JobChunk<T>
 * -------------
 * Public streaming contract exposed by the Job system.
 *
 * A JobChunk represents *semantic output only* and is intentionally
 * decoupled from provider- or orchestration-level details.
 *
 * Design rules:
 * - Job consumers MUST NOT receive provider metadata, raw payloads,
 *   retry information, or execution policy details.
 * - Executors are responsible for translating internal AIResponseChunk<T>
 *   values into JobChunk<T>.
 *
 * Mapping rules:
 * - AIResponseChunk.delta   → JobChunk.delta
 * - AIResponseChunk.output  → JobChunk.final
 * - AIResponseChunk.done    → implied by presence of JobChunk.final
 * - All other AIResponseChunk fields (metadata, raw, provider info, etc.)
 *   are intentionally dropped.
 *
 * Invariants:
 * - A JobChunk MUST contain at most one of { delta, final }.
 * - `final` MUST be emitted at most once.
 * - `final` MUST represent the complete logical output of the job.
 *
 * This abstraction allows streaming to remain stable across:
 * - providers (OpenAI, Anthropic, etc.)
 * - modalities (text, audio, image, video)
 */
export type JobChunk<TOutput> = {
    delta?: TOutput;
    final?: TOutput;
};

export interface JobLifecycleHooks<TOutput> {
    onStart?: () => void;
    onProgress?: (info: any) => void;
    onComplete?: (output: TOutput) => void;
    onError?: (error: Error) => void;
}

export interface Job<TInput = any, TOutput = any> {
    readonly id: string;
    readonly input: TInput;
    readonly output?: TOutput;
    readonly status: JobStatus;
    readonly error?: Error;

    run(ctx: MultiModalExecutionContext, signal?: AbortSignal): Promise<void>;
}
