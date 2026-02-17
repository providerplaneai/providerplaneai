import { JobStatus, TimelineArtifacts } from "#root/index.js";

export interface JobSnapshot<TInput, TOutput> {
    id: string;
    status: JobStatus;
    input: TInput;
    output?: TOutput;
    error?: string;

    multimodalArtifacts?: TimelineArtifacts;

    durationMs?: number;

    /**
     * Streaming metadata.
     * Present only for jobs that emit streaming chunks.
     */
    streaming?: {
        /** Whether the job supports streaming */
        enabled: boolean;

        /** True once the first delta chunk is emitted */
        started: boolean;

        /** Number of delta chunks emitted so far */
        chunksEmitted: number;

        /** True once final output has been emitted */
        completed: boolean;

        /** Timestamp of last chunk emission */
        lastChunkAt?: number;
    };
}