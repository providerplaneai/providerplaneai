import { CapabilityKeyType, JobStatus, ProviderRef, TimelineArtifacts } from "#root/index.js";

export interface JobSnapshot<TInput, TOutput> {
    /** Snapshot schema version for persistence compatibility. */
    schemaVersion?: 1;

    id: string;
    /** Capability key used to create this job (required for deterministic restore/rerun). */
    capability?: CapabilityKeyType;
    /** Optional per-job provider chain override used during execution. */
    providerChain?: ProviderRef[];
    status: JobStatus;
    input: TInput;
    output?: TOutput;
    error?: string;

    multimodalArtifacts?: TimelineArtifacts;

    /** Job start timestamp in epoch milliseconds. */
    startedAt?: number;

    /** Job end timestamp in epoch milliseconds. */
    endedAt?: number;

    /** Number of execution attempts for this job. */
    runCount?: number;

    /** Timestamp when this job was restored from persistence (if applicable). */
    restoredFromSnapshotAt?: number;

    durationMs?: number;

    /**
     * Streaming metadata.
     * Present only for jobs that emit streaming chunks.
     */
    streaming?: {
        /** Whether the job supports streaming */
        enabled: boolean;

        /** True once the first public JobChunk is emitted */
        started: boolean;

        /** Number of public JobChunk emissions so far (delta and final) */
        chunksEmitted: number;

        /** True once the final JobChunk is emitted */
        completed: boolean;

        /** Timestamp of last chunk emission */
        lastChunkAt?: number;
    };
}
