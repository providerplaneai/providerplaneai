import { GenericJob, JobChunk, JobSnapshot, MultiModalExecutionContext } from "#root/index.js";

/**
 * Callback type for subscribers to job status updates.
 *
 * @template TInput Input type for the job
 * @template TOutput Output type for the job
 * @param snapshot The current snapshot of the job
 */
type JobSubscriber<TInput, TOutput> = (snapshot: JobSnapshot<TInput, TOutput>) => void;

/**
 * Represents a job and its execution context queued for processing.
 */
interface QueuedJob<TInput, TOutput> {
    job: GenericJob<TInput, TOutput>;
    ctx: MultiModalExecutionContext;
}

/**
 * Optional hooks for job lifecycle events.
 */
export interface JobManagerHooks {
    /** Called when a job starts running. */
    onStart?: (job: JobSnapshot<any, any>) => void;
    /** Called when a job emits a progress chunk. */
    onProgress?: (chunk: JobChunk<any>, job: JobSnapshot<any, any>) => void;
    /** Called when a job completes successfully. */
    onComplete?: (job: JobSnapshot<any, any>) => void;
    /** Called when a job errors. */
    onError?: (error: Error, job: JobSnapshot<any, any>) => void;
}

/**
 * Function type for reconstructing a GenericJob from a persisted snapshot.
 * Restores executor, streaming, and hooks so it can be rerun.
 *
 * @template TInput Input type for the job
 * @template TOutput Output type for the job
 * @param snapshot The persisted job snapshot
 * @returns The reconstructed GenericJob
 */
export type JobFactory<TInput, TOutput> = (snapshot: JobSnapshot<TInput, TOutput>) => GenericJob<TInput, TOutput>;

/**
 * Options for configuring the JobManager.
 */
export interface JobManagerOptions {
    /** Maximum number of jobs to run concurrently. */
    maxConcurrency?: number;
    /** Maximum number of jobs allowed in the queue. */
    maxQueueSize?: number;
    /** Maximum number of response chunks to store per job. */
    maxStoredResponseChunks?: number;
    /** Whether to store raw responses for jobs. */
    storeRawResponses?: boolean;
    /** Maximum raw bytes to store per job. */
    maxRawBytesPerJob?: number;
    /** Optional hooks for job lifecycle events. */
    hooks?: JobManagerHooks;

    /** Optional persistence hooks */
    persistJobs?: (snapshots: JobSnapshot<any, any>[]) => void;
    loadPersistedJobs?: () => JobSnapshot<any, any>[];

    /** Factory for reconstructing jobs from snapshots. */
    jobFactory?: JobFactory<any, any>;
}

/**
 * Manages the lifecycle, execution, and persistence of jobs.
 * Supports concurrency, queuing, hooks, and job restoration.
 */
export class JobManager {
    /** All jobs managed by this instance, keyed by job ID. */
    private jobs: Map<string, GenericJob<any, any>> = new Map();
    /** AbortControllers for running jobs, keyed by job ID. */
    private controllers: Map<string, AbortController> = new Map();
    /** Subscribers to job status updates, keyed by job ID. */
    private subscribers = new Map<string, Set<JobSubscriber<any, any>>>();
    /** Queue of jobs waiting to be executed. */
    private jobQueue: QueuedJob<any, any>[] = [];
    /** Number of jobs currently running. */
    private runningCount: number = 0;

    /**
     * Constructs a new JobManager with the given options.
     *
     * @param options Configuration options for the manager
     */
    constructor(private options?: JobManagerOptions) {
        this.setMaxConcurrency(this.options?.maxConcurrency);
        this.setMaxQueueSize(this.options?.maxQueueSize);
        this.setMaxStoredResponseChunks(this.options?.maxStoredResponseChunks);
        this.setStoreRawResponses(this.options?.storeRawResponses);
        this.setMaxRawBytesPerJob(this.options?.maxRawBytesPerJob);

        // Restore persisted jobs on startup
        this.restorePersistedJobs();
    }

    /**
     * Gets the maximum number of jobs that can run concurrently.
     */
    getMaxConcurrency(): number | undefined {
        return this.options?.maxConcurrency;
    }

    /**
     * Sets the maximum number of jobs that can run concurrently.
     *
     * @param maxConcurrency The new concurrency limit
     */
    setMaxConcurrency(maxConcurrency: number | undefined) {
        if (maxConcurrency !== undefined && (!Number.isInteger(maxConcurrency) || maxConcurrency < 0)) {
            throw new Error("JobManager: maxConcurrency must be a non-negative integer");
        }
        this.options = this.options ?? {};
        this.options.maxConcurrency = maxConcurrency;
    }

    /**
     * Gets the maximum number of response chunks stored per job.
     */
    getMaxStoredResponseChunks(): number | undefined {
        return this.options?.maxStoredResponseChunks;
    }

    /**
     * Sets the maximum number of response chunks stored per job.
     *
     * @param maxStoredResponseChunks The new chunk limit
     */
    setMaxStoredResponseChunks(maxStoredResponseChunks: number | undefined) {
        if (
            maxStoredResponseChunks !== undefined &&
            (!Number.isInteger(maxStoredResponseChunks) || maxStoredResponseChunks < 0)
        ) {
            throw new Error("JobManager: maxStoredResponseChunks must be a non-negative integer");
        }
        this.options = this.options ?? {};
        this.options.maxStoredResponseChunks = maxStoredResponseChunks;
    }

    /**
     * Gets the maximum number of jobs allowed in the queue.
     */
    getMaxQueueSize(): number | undefined {
        return this.options?.maxQueueSize;
    }

    /**
     * Sets the maximum number of jobs allowed in the queue.
     *
     * @param maxQueueSize The new queue size limit
     */
    setMaxQueueSize(maxQueueSize: number | undefined) {
        if (maxQueueSize !== undefined && (!Number.isInteger(maxQueueSize) || maxQueueSize < 0)) {
            throw new Error("JobManager: maxQueueSize must be a non-negative integer");
        }
        this.options = this.options ?? {};
        this.options.maxQueueSize = maxQueueSize;
    }

    /**
     * Gets whether raw responses are stored for jobs.
     */
    getStoreRawResponses(): boolean | undefined {
        return this.options?.storeRawResponses;
    }

    /**
     * Sets whether raw responses are stored for jobs.
     *
     * @param storeRawResponses True to store raw responses
     */
    setStoreRawResponses(storeRawResponses: boolean | undefined) {
        if (storeRawResponses !== undefined && typeof storeRawResponses !== "boolean") {
            throw new Error("JobManager: storeRawResponses must be a boolean");
        }
        this.options = this.options ?? {};
        this.options.storeRawResponses = storeRawResponses;
    }

    /**
     * Gets the maximum number of raw bytes to store per job.
     */
    getMaxRawBytesPerJob(): number | undefined {
        return this.options?.maxRawBytesPerJob;
    }

    /**
     * Sets the maximum number of raw bytes to store per job.
     *
     * @param maxRawBytesPerJob The new byte limit
     */
    setMaxRawBytesPerJob(maxRawBytesPerJob: number | undefined) {
        if (maxRawBytesPerJob !== undefined && (!Number.isInteger(maxRawBytesPerJob) || maxRawBytesPerJob < 0)) {
            throw new Error("JobManager: maxRawBytesPerJob must be a non-negative integer");
        }
        this.options = this.options ?? {};
        this.options.maxRawBytesPerJob = maxRawBytesPerJob;
    }

    /**
     * Gets the current number of jobs in the queue.
     */
    getQueueLength(): number {
        return this.jobQueue.length;
    }

    /**
     * Gets the current number of jobs running.
     */
    getRunningCount(): number {
        return this.runningCount;
    }

    /**
     * Wires up job status change handler to persist and notify subscribers.
     *
     * @param job The job to wire
     */
    private wireJob<TInput, TOutput>(job: GenericJob<TInput, TOutput>) {
        const existingStatusHandler = job.onStatusChange;
        job.onStatusChange = (status) => {
            existingStatusHandler?.(status);
            this.persist();
            this.notifySubscribers(job.id);
        };
    }

    /**
     * Restores jobs from persisted snapshots using the jobFactory or fallback logic.
     * Handles schema versioning and ensures jobs are restorable even if executors are missing.
     */
    private restorePersistedJobs() {
        if (!this.options?.loadPersistedJobs) {
            return;
        }

        const snapshots = this.options.loadPersistedJobs();

        for (const snap of snapshots) {
            const schemaVersion = snap.schemaVersion ?? 1;
            if (schemaVersion !== 1) {
                throw new Error(`Unsupported JobSnapshot schemaVersion: ${schemaVersion}`);
            }

            let job: GenericJob<any, any>;
            if (this.options.jobFactory) {
                try {
                    job = this.options.jobFactory(snap);
                } catch (err: any) {
                    const message = err instanceof Error ? err.message : String(err);
                    // If the factory cannot recreate the executor (e.g. missing custom capability registration),
                    // keep the snapshot restorable instead of failing all job restoration.
                    job = new GenericJob<any, any>(
                        snap.input,
                        snap.streaming?.enabled ?? false,
                        async () => {
                            throw new Error(`Restored job '${snap.id}' cannot be executed: ${message}`);
                        },
                        undefined,
                        this.options?.maxStoredResponseChunks,
                        {
                            capability: snap.capability,
                            providerChain: snap.providerChain,
                            storeRawResponses: this.options?.storeRawResponses,
                            maxRawBytesPerJob: this.options?.maxRawBytesPerJob
                        }
                    );
                }
            } else {
                job = new GenericJob<any, any>(
                    snap.input,
                    snap.streaming?.enabled ?? false,
                    async () => {
                        throw new Error("Restored job cannot be executed");
                    },
                    undefined,
                    this.options?.maxStoredResponseChunks,
                    {
                        capability: snap.capability,
                        providerChain: snap.providerChain,
                        storeRawResponses: this.options?.storeRawResponses,
                        maxRawBytesPerJob: this.options?.maxRawBytesPerJob
                    }
                );
            }
            job.restoreFromSnapshot(snap);
            this.wireJob(job);

            this.jobs.set(job.id, job);
        }
    }

    /**
     * Adds a new job to the manager. Throws if the job ID already exists.
     *
     * @param job The job to add
     */
    addJob<TInput, TOutput>(job: GenericJob<TInput, TOutput>) {
        if (this.jobs.has(job.id)) {
            throw new Error(`JobManager: job '${job.id}' already exists`);
        }

        this.wireJob(job);

        this.jobs.set(job.id, job);
        this.persist();
    }

    /**
     * Retrieves a job by its ID.
     *
     * @param id The job ID
     * @returns The job, or undefined if not found
     */
    getJob<TInput, TOutput>(id: string): GenericJob<TInput, TOutput> | undefined {
        return this.jobs.get(id) as GenericJob<TInput, TOutput> | undefined;
    }

    /**
     * Queues a job for execution. Throws if already running, queued, or not found.
     *
     * @param id The job ID
     * @param ctx The execution context
     * @param onChunk Optional callback for progress chunks
     * @returns The job instance
     */
    runJob<TInput, TOutput>(
        id: string,
        ctx: MultiModalExecutionContext,
        onChunk?: (chunk: JobChunk<TOutput>) => void
    ): GenericJob<TInput, TOutput> {
        if (this.options?.maxConcurrency === 0) {
            throw new Error("JobManager: maxConcurrency is 0; job execution is disabled");
        }
        if (this.options?.maxQueueSize !== undefined && this.jobQueue.length >= this.options.maxQueueSize) {
            throw new Error("JobManager: queue is full");
        }
        const job = this.getJob<TInput, TOutput>(id);
        if (!job) {
            throw new Error(`JobManager: job '${id}' not found`);
        }
        if (job.status === "running") {
            throw new Error(`JobManager: job '${id}' is already running`);
        }
        if (this.jobQueue.some((q) => q.job.id === id)) {
            throw new Error(`JobManager: job '${id}' is already queued`);
        }
        // Attach chunk callback for streaming progress
        job.onChunk = onChunk;

        this.jobQueue.push({ job, ctx });
        this.processQueue();
        return job;
    }

    /**
     * Resets and reruns a job by ID. Throws if not found or already running.
     *
     * @param id The job ID
     * @param ctx The execution context
     * @param onChunk Optional callback for progress chunks
     * @returns The job instance
     */
    rerunJob<TInput, TOutput>(
        id: string,
        ctx: MultiModalExecutionContext,
        onChunk?: (chunk: JobChunk<TOutput>) => void
    ): GenericJob<TInput, TOutput> {
        const job = this.getJob<TInput, TOutput>(id);
        if (!job) {
            throw new Error(`JobManager: job '${id}' not found`);
        }
        if (job.status === "running") {
            throw new Error(`JobManager: job '${id}' is running and cannot be rerun`);
        }

        // Reset job state before rerunning
        job.reset();

        this.runJob(id, ctx, onChunk);
        return job;
    }

    /**
     * Processes the job queue, running jobs up to the concurrency limit.
     * Handles job lifecycle, hooks, and error propagation.
     */
    private processQueue() {
        while (this.runningCount < (this.options?.maxConcurrency ?? Infinity) && this.jobQueue.length > 0) {
            // Dequeue the next job
            const { job, ctx } = this.jobQueue.shift()!;
            this.runningCount++;
            let finalized = false;
            /**
             * Finalizes job execution, cleaning up state and triggering next jobs.
             */
            const finalize = () => {
                if (finalized) {
                    return;
                }
                finalized = true;
                // Cleanup must happen exactly once per dequeued job to keep queue/running
                // counters and persistence snapshots consistent.
                this.controllers.delete(job.id);
                this.runningCount--;
                this.persist();
                this.notifySubscribers(job.id);
                this.processQueue();
            };

            // Create per-job AbortController for cancellation
            const controller = new AbortController();
            this.controllers.set(job.id, controller);

            // Trigger onStart hook
            this.options?.hooks?.onStart?.(job.toSnapshot());

            // Chunk callback for streaming progress
            const chunkCallback = (chunk: JobChunk<any>) => {
                job.onChunk?.(chunk);
                this.options?.hooks?.onProgress?.(chunk, job.toSnapshot());
                this.notifySubscribers(job.id);
            };

            // Fire and forget - job will update its own status and notify subscribers/hooks on completion/error
            const runPromise = job.run(ctx, controller.signal, chunkCallback);

            // Lifecycle is driven from completionPromise because it is the canonical
            // terminal signal for both streaming and non-streaming executions.
            job.getCompletionPromise()
                .then(() => {
                    this.options?.hooks?.onComplete?.(job.toSnapshot());
                })
                .catch((err) => {
                    this.options?.hooks?.onError?.(err, job.toSnapshot());
                })
                .finally(finalize);

            // Defensive guard: if run() rejects before completionPromise settles,
            // avoid leaking a running slot.
            runPromise.catch((err) => {
                const normalized = err instanceof Error ? err : new Error(String(err));
                this.options?.hooks?.onError?.(normalized, job.toSnapshot());
                finalize();
            });
        }
    }

    /**
     * Aborts a job by ID, removing it from the queue and signaling cancellation.
     *
     * @param id The job ID
     * @param reason Optional reason for aborting
     */
    abortJob(id: string, reason?: string) {
        const job = this.getJob(id);
        if (!job) {
            throw new Error(`JobManager: job '${id}' not found`);
        }

        // Remove queued entries so aborted pending jobs do not execute later.
        this.jobQueue = this.jobQueue.filter((q) => q.job.id !== id);

        const controller = this.controllers.get(id);
        if (controller) {
            // AbortController.signal.reason can be passed via a new Error
            controller.abort(new Error(reason ?? "Job aborted"));
        }

        // Update job status and notify subscribers
        job.markAborted(reason ? new Error(reason) : undefined);
        this.persist();
        this.notifySubscribers(id);
    }

    /**
     * Lists all jobs managed by this instance as snapshots.
     * @returns Array of job snapshots
     */
    listJobs(): JobSnapshot<any, any>[] {
        return Array.from(this.jobs.values()).map((j) => j.toSnapshot());
    }

    /**
     * Persists all jobs using the provided persistence hook, if any.
     */
    private persist() {
        if (this.options?.persistJobs) {
            this.options.persistJobs(this.listJobs());
        }
    }

    /**
     * Subscribes to status updates for a specific job.
     *
     * @param jobId The job ID
     * @param subscriber The callback to invoke on updates
     * @returns Unsubscribe function
     */
    subscribe<TInput, TOutput>(jobId: string, subscriber: JobSubscriber<TInput, TOutput>) {
        if (!this.subscribers.has(jobId)) {
            this.subscribers.set(jobId, new Set());
        }
        this.subscribers.get(jobId)!.add(subscriber);

        // Immediately notify with current snapshot if job exists
        const job = this.jobs.get(jobId);
        if (job) {
            subscriber(job.toSnapshot());
        }

        return () => this.subscribers.get(jobId)?.delete(subscriber);
    }

    /**
     * Notifies all subscribers of a job's status update.
     *
     * @param jobId The job ID
     */
    private notifySubscribers(jobId: string) {
        const job = this.jobs.get(jobId);
        if (!job) {
            return;
        }
        const subs = this.subscribers.get(jobId);
        if (!subs) {
            return;
        }

        const snapshot = job.toSnapshot();
        for (const sub of subs) {
            sub(snapshot);
        }
    }
}
