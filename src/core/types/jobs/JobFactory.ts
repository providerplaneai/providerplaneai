import { AIResponse, AIResponseChunk, GenericJob, JobChunk, JobSnapshot, MultiModalExecutionContext, JobLifecycleHooks } from "#root/index.js";

/**
 * JobFactory<TInput, TOutput>
 * 
 * Reconstructs a GenericJob from a persisted snapshot, restoring its
 * executor, streaming, and hooks so it can be rerun.
 */
export type JobFactory<TInput, TOutput> = (
    snapshot: JobSnapshot<TInput, TOutput>
) => GenericJob<TInput, TOutput>;

/**
 * Example factory function.
 *
 * @param snapshot persisted JobSnapshot
 * @param executor function that actually executes the job
 * @param hooks optional lifecycle hooks
 */
export function createJobFactory<TInput, TOutput>(
    executor: (
        input: TInput,
        ctx: MultiModalExecutionContext,
        signal?: AbortSignal,
        onChunk?: (chunk: JobChunk<TOutput>, internalChunk?: AIResponseChunk<TOutput>) => void
    ) => Promise<AIResponse<TOutput>>,
    hooks?: JobLifecycleHooks<TOutput>
): JobFactory<TInput, TOutput> {
    return (snapshot: JobSnapshot<TInput, TOutput>) => {
        const schemaVersion = snapshot.schemaVersion ?? 1;
        if (schemaVersion !== 1) {
            throw new Error(`Unsupported JobSnapshot schemaVersion: ${schemaVersion}`);
        }

        const job = new GenericJob<TInput, TOutput>(
            snapshot.input,
            snapshot.streaming?.enabled ?? false,
            executor,
            hooks,
            undefined,
            { capability: snapshot.capability, providerChain: snapshot.providerChain }
        );

        job.restoreFromSnapshot(snapshot);

        return job;
    };
}

