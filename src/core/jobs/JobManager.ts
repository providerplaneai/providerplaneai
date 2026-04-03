/**
 * @module core/jobs/JobManager.ts
 * @description Job execution, persistence, and queue orchestration utilities.
 */
import { GenericJob, JobChunk, JobSnapshot, MultiModalExecutionContext } from "#root/index.js";

/**
 * Callback type for subscribers to job status updates.
 *
 * @template TInput - Input type for the job.
 * @template TOutput - Output type for the job.
 * @param {JobSnapshot<TInput, TOutput>} snapshot The current persisted view of the job.
 */
export type JobSubscriber<TInput, TOutput> = (snapshot: JobSnapshot<TInput, TOutput>) => void;

/**
 * Represents a job and its execution context queued for processing.
 */
interface QueuedJob<TInput, TOutput> {
    job: GenericJob<TInput, TOutput>;
    ctx: MultiModalExecutionContext;
}

/**
 * Optional callbacks invoked as jobs move through their lifecycle.
 *
 * @public
 */
export interface JobManagerHooks {
    /**
     * Called when a job starts running.
     */
    onStart?: (job: JobSnapshot<any, any>) => void;
    /**
     * Called when a job emits a progress chunk.
     */
    onProgress?: (chunk: JobChunk<any>, job: JobSnapshot<any, any>) => void;
    /**
     * Called when a job completes successfully.
     */
    onComplete?: (job: JobSnapshot<any, any>) => void;
    /**
     * Called when a job errors.
     */
    onError?: (error: Error, job: JobSnapshot<any, any>) => void;
}

/**
 * Function type for reconstructing a GenericJob from a persisted snapshot.
 * Restores executor, streaming, and hooks so it can be rerun.
 *
 * @template TInput - Input type for the job.
 * @template TOutput - Output type for the job.
 * @param {JobSnapshot<TInput, TOutput>} snapshot The persisted job snapshot.
 * @returns {GenericJob<TInput, TOutput>} The reconstructed job instance.
 */
export type JobFactory<TInput, TOutput> = (snapshot: JobSnapshot<TInput, TOutput>) => GenericJob<TInput, TOutput>;

/**
 * Configuration for job queue behavior, persistence, and runtime hooks.
 *
 * @public
 */
export interface JobManagerOptions {
    /**
     * Maximum number of jobs to run concurrently.
     */
    maxConcurrency?: number;
    /**
     * Maximum number of jobs allowed in the queue.
     */
    maxQueueSize?: number;
    /**
     * Maximum number of response chunks to store per job.
     */
    maxStoredResponseChunks?: number;
    /**
     * Whether to store raw responses for jobs.
     */
    storeRawResponses?: boolean;
    /**
     * Whether to strip binary-heavy fields (e.g. base64) from snapshots and timeline artifacts.
     */
    stripBinaryPayloadsInSnapshotsAndTimeline?: boolean;
    /**
     * Maximum raw bytes to store per job.
     */
    maxRawBytesPerJob?: number;
    /**
     * Optional hooks for job lifecycle events.
     */
    hooks?: JobManagerHooks;
    /**
     * Optional persistence hooks
     */
    persistJobs?: (snapshots: JobSnapshot<any, any>[]) => void;
    loadPersistedJobs?: () => JobSnapshot<any, any>[];
    /**
     * Factory for reconstructing jobs from snapshots.
     */
    jobFactory?: JobFactory<any, any>;
}

/**
 * Coordinates queued job execution, persistence, and subscriber notification.
 *
 * @public
 */
export class JobManager {
    /**
     * All jobs managed by this instance, keyed by job ID.
     */
    private jobs: Map<string, GenericJob<any, any>> = new Map();
    /**
     * AbortControllers for running jobs, keyed by job ID.
     */
    private controllers: Map<string, AbortController> = new Map();
    /**
     * Subscribers to job status updates, keyed by job ID.
     */
    private subscribers = new Map<string, Set<JobSubscriber<any, any>>>();
    /**
     * Queue of jobs waiting to be executed.
     */
    private jobQueue: QueuedJob<any, any>[] = [];
    /**
     * O(1) membership tracking for queued job IDs.
     */
    private queuedJobIds = new Set<string>();
    /**
     * Number of jobs currently running.
     */
    private runningCount: number = 0;
    /**
     * Whether a coalesced persistence flush has already been queued.
     */
    private persistFlushQueued = false;
    /**
     * Job IDs with snapshot state changes since the last persistence flush.
     */
    private dirtyJobs = new Set<string>();
    /**
     * Cached snapshots keyed by job id, reused across persistence flushes.
     */
    private snapshotCache = new Map<string, JobSnapshot<any, any>>();

    /**
     * Constructs a new JobManager with the given options.
     *
     * @param {JobManagerOptions | undefined} [options] Configuration for concurrency, persistence, and hooks.
     */
    constructor(private options?: JobManagerOptions) {
        this.setMaxConcurrency(this.options?.maxConcurrency);
        this.setMaxQueueSize(this.options?.maxQueueSize);
        this.setMaxStoredResponseChunks(this.options?.maxStoredResponseChunks);
        this.setStoreRawResponses(this.options?.storeRawResponses);
        this.setStripBinaryPayloadsInSnapshotsAndTimeline(this.options?.stripBinaryPayloadsInSnapshotsAndTimeline);
        this.setMaxRawBytesPerJob(this.options?.maxRawBytesPerJob);

        // Restore persisted jobs on startup
        this.restorePersistedJobs();
    }

    /**
     * Gets the maximum number of jobs that can run concurrently.
     *
     * @returns {number | undefined} The configured concurrency limit, or `undefined` when unbounded.
     */
    getMaxConcurrency(): number | undefined {
        return this.options?.maxConcurrency;
    }

    /**
     * Sets the maximum number of jobs that can run concurrently.
     *
     * @param {number | undefined} maxConcurrency The new concurrency limit.
     * @returns {void} Nothing.
     * @throws {Error} Thrown when the value is not a non-negative integer.
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
     *
     * @returns {number | undefined} The configured chunk retention limit.
     */
    getMaxStoredResponseChunks(): number | undefined {
        return this.options?.maxStoredResponseChunks;
    }

    /**
     * Sets the maximum number of response chunks stored per job.
     *
     * @param {number | undefined} maxStoredResponseChunks The new chunk retention limit.
     * @returns {void} Nothing.
     * @throws {Error} Thrown when the value is not a non-negative integer.
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
     *
     * @returns {number | undefined} The configured queue size limit.
     */
    getMaxQueueSize(): number | undefined {
        return this.options?.maxQueueSize;
    }

    /**
     * Sets the maximum number of jobs allowed in the queue.
     *
     * @param {number | undefined} maxQueueSize The new queue size limit.
     * @returns {void} Nothing.
     * @throws {Error} Thrown when the value is not a non-negative integer.
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
     *
     * @returns {boolean | undefined} Whether raw provider responses are retained.
     */
    getStoreRawResponses(): boolean | undefined {
        return this.options?.storeRawResponses;
    }

    /**
     * Sets whether raw responses are stored for jobs.
     *
     * @param {boolean | undefined} storeRawResponses Whether raw provider responses should be retained.
     * @returns {void} Nothing.
     * @throws {Error} Thrown when the value is not a boolean.
     */
    setStoreRawResponses(storeRawResponses: boolean | undefined) {
        if (storeRawResponses !== undefined && typeof storeRawResponses !== "boolean") {
            throw new Error("JobManager: storeRawResponses must be a boolean");
        }
        this.options = this.options ?? {};
        this.options.storeRawResponses = storeRawResponses;
    }

    /**
     * Gets whether binary-heavy fields are stripped from snapshots and timeline artifacts.
     *
     * @returns {boolean | undefined} Whether binary-heavy data is stripped before persistence.
     */
    getStripBinaryPayloadsInSnapshotsAndTimeline(): boolean | undefined {
        return this.options?.stripBinaryPayloadsInSnapshotsAndTimeline;
    }

    /**
     * Sets whether binary-heavy fields are stripped from snapshots and timeline artifacts.
     *
     * @param {boolean | undefined} stripBinaryPayloadsInSnapshotsAndTimeline Whether binary-heavy fields should be stripped.
     * @returns {void} Nothing.
     * @throws {Error} Thrown when the value is not a boolean.
     */
    setStripBinaryPayloadsInSnapshotsAndTimeline(stripBinaryPayloadsInSnapshotsAndTimeline: boolean | undefined) {
        if (
            stripBinaryPayloadsInSnapshotsAndTimeline !== undefined &&
            typeof stripBinaryPayloadsInSnapshotsAndTimeline !== "boolean"
        ) {
            throw new Error("JobManager: stripBinaryPayloadsInSnapshotsAndTimeline must be a boolean");
        }
        this.options = this.options ?? {};
        this.options.stripBinaryPayloadsInSnapshotsAndTimeline = stripBinaryPayloadsInSnapshotsAndTimeline;
    }

    /**
     * Gets the maximum number of raw bytes to store per job.
     *
     * @returns {number | undefined} The raw-response byte budget for each job.
     */
    getMaxRawBytesPerJob(): number | undefined {
        return this.options?.maxRawBytesPerJob;
    }

    /**
     * Sets the maximum number of raw bytes to store per job.
     *
     * @param {number | undefined} maxRawBytesPerJob The new raw-response byte limit.
     * @returns {void} Nothing.
     * @throws {Error} Thrown when the value is not a non-negative integer.
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
     *
     * @returns {number} The number of jobs currently waiting to run.
     */
    getQueueLength(): number {
        return this.jobQueue.length;
    }

    /**
     * Gets the current number of jobs running.
     *
     * @returns {number} The number of jobs currently executing.
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
            this.markJobDirty(job.id);
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
                            stripBinaryPayloadsInSnapshotsAndTimeline: this.options?.stripBinaryPayloadsInSnapshotsAndTimeline,
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
                        stripBinaryPayloadsInSnapshotsAndTimeline: this.options?.stripBinaryPayloadsInSnapshotsAndTimeline,
                        maxRawBytesPerJob: this.options?.maxRawBytesPerJob
                    }
                );
            }
            job.restoreFromSnapshot(snap);
            this.wireJob(job);

            this.jobs.set(job.id, job);
            this.snapshotCache.set(job.id, snap);
        }
    }

    /**
     * Adds a new job to the manager. Throws if the job ID already exists.
     *
     * @template TInput - Input type for the job.
     * @template TOutput - Output type for the job.
     * @param {GenericJob<TInput, TOutput>} job The job to register.
     * @returns {void} Nothing.
     * @throws {Error} Thrown when a job with the same identifier already exists.
     */
    addJob<TInput, TOutput>(job: GenericJob<TInput, TOutput>) {
        if (this.jobs.has(job.id)) {
            throw new Error(`JobManager: job '${job.id}' already exists`);
        }

        this.wireJob(job);

        this.jobs.set(job.id, job);
        this.markJobDirty(job.id);
        this.persist();
    }

    /**
     * Retrieves a job by its ID.
     *
     * @template TInput - Expected input type for the job.
     * @template TOutput - Expected output type for the job.
     * @param {string} id The job identifier.
     * @returns {GenericJob<TInput, TOutput> | undefined} The job instance, or `undefined` when no such job exists.
     */
    getJob<TInput, TOutput>(id: string): GenericJob<TInput, TOutput> | undefined {
        return this.jobs.get(id) as GenericJob<TInput, TOutput> | undefined;
    }

    /**
     * Queues a job for execution. Throws if already running, queued, or not found.
     *
     * @template TInput - Expected input type for the job.
     * @template TOutput - Expected output type for the job.
     * @param {string} id The job identifier.
     * @param {MultiModalExecutionContext} ctx The execution context passed to the job executor.
     * @param {(chunk: JobChunk<TOutput>) => void | undefined} [onChunk] Optional progress callback for streamed chunks.
     * @returns {GenericJob<TInput, TOutput>} The queued job instance.
     * @throws {Error} Thrown when execution is disabled, the queue is full, or the job is missing/already queued.
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
        if (this.queuedJobIds.has(id)) {
            throw new Error(`JobManager: job '${id}' is already queued`);
        }
        // Attach chunk callback for streaming progress
        job.onChunk = onChunk;
        // Keep timeline storage behavior aligned with manager/runtime settings.
        ctx.setStripBinaryPayloadsInTimeline(this.options?.stripBinaryPayloadsInSnapshotsAndTimeline ?? false);

        this.jobQueue.push({ job, ctx });
        this.queuedJobIds.add(id);
        this.processQueue();
        return job;
    }

    /**
     * Resets and reruns a job by ID. Throws if not found or already running.
     *
     * @template TInput - Expected input type for the job.
     * @template TOutput - Expected output type for the job.
     * @param {string} id The job identifier.
     * @param {MultiModalExecutionContext} ctx The execution context passed to the job executor.
     * @param {(chunk: JobChunk<TOutput>) => void | undefined} [onChunk] Optional progress callback for streamed chunks.
     * @returns {GenericJob<TInput, TOutput>} The reset and requeued job instance.
     * @throws {Error} Thrown when the job is missing or currently running.
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
            this.queuedJobIds.delete(job.id);
            this.runningCount++;
            let finalized = false;
            let errorFired = false;
            /**
             * Finalizes job execution, cleaning up state and triggering next jobs.
             */
            const finalize = (snapshot?: JobSnapshot<any, any>) => {
                if (finalized) {
                    return;
                }
                finalized = true;
                // Cleanup must happen exactly once per dequeued job to keep queue/running
                // counters and persistence snapshots consistent.
                this.controllers.delete(job.id);
                this.runningCount--;
                this.persist();
                this.notifySubscribers(job.id, snapshot);
                this.processQueue();
            };

            // Create per-job AbortController for cancellation
            const controller = new AbortController();
            this.controllers.set(job.id, controller);

            // Trigger onStart hook
            const startSnapshot = job.toSnapshot();
            this.options?.hooks?.onStart?.(startSnapshot);

            // Chunk callback for streaming progress
            const chunkCallback = (chunk: JobChunk<any>) => {
                job.onChunk?.(chunk);
                const hasProgressHook = !!this.options?.hooks?.onProgress;
                const hasSubscribers = (this.subscribers.get(job.id)?.size ?? 0) > 0;
                if (!hasProgressHook && !hasSubscribers) {
                    return;
                }
                const progressSnapshot = job.toSnapshot();
                this.options?.hooks?.onProgress?.(chunk, progressSnapshot);
                if (hasSubscribers) {
                    this.notifySubscribers(job.id, progressSnapshot);
                }
            };

            // Fire and forget - job will update its own status and notify subscribers/hooks on completion/error
            const runPromise = job.run(ctx, controller.signal, chunkCallback);

            // Lifecycle is driven from completionPromise because it is the canonical
            // terminal signal for both streaming and non-streaming executions.
            job.getCompletionPromise()
                .then(() => {
                    const completedSnapshot = job.toSnapshot();
                    this.options?.hooks?.onComplete?.(completedSnapshot);
                    return completedSnapshot;
                })
                .then((completedSnapshot) => completedSnapshot)
                .catch((err) => {
                    errorFired = true;
                    const erroredSnapshot = job.toSnapshot();
                    this.options?.hooks?.onError?.(err, erroredSnapshot);
                    return erroredSnapshot;
                })
                .then((terminalSnapshot) => {
                    finalize(terminalSnapshot);
                });

            // Defensive guard: if run() rejects before completionPromise settles,
            // avoid leaking a running slot.
            runPromise.catch((err) => {
                const normalized = err instanceof Error ? err : new Error(String(err));
                const erroredSnapshot = job.toSnapshot();
                if (!errorFired) {
                    this.options?.hooks?.onError?.(normalized, erroredSnapshot);
                }
                finalize(erroredSnapshot);
            });
        }
    }

    /**
     * Aborts a job by ID, removing it from the queue and signaling cancellation.
     *
     * @param {string} id The job identifier.
     * @param {string | undefined} [reason] Optional human-readable abort reason.
     * @returns {void} Nothing.
     * @throws {Error} Thrown when the job cannot be found.
     */
    abortJob(id: string, reason?: string) {
        const job = this.getJob(id);
        if (!job) {
            throw new Error(`JobManager: job '${id}' not found`);
        }

        // Remove queued entries so aborted pending jobs do not execute later.
        if (this.queuedJobIds.has(id)) {
            this.jobQueue = this.jobQueue.filter((q) => q.job.id !== id);
            this.queuedJobIds.delete(id);
        }

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
     * @returns {JobSnapshot<any, any>[]} Snapshots for every known job.
     */
    listJobs(): JobSnapshot<any, any>[] {
        return Array.from(this.jobs.values()).map((j) => j.toSnapshot());
    }

    /**
     * Persists all jobs using the provided persistence hook, if any.
     */
    private persist() {
        if (!this.options?.persistJobs) {
            return;
        }

        // Coalesce frequent status transitions in the same tick into one snapshot write.
        if (this.persistFlushQueued) {
            return;
        }
        this.persistFlushQueued = true;
        queueMicrotask(() => {
            this.persistFlushQueued = false;
            if (this.dirtyJobs.size === 0) {
                return;
            }

            for (const jobId of this.dirtyJobs) {
                const job = this.jobs.get(jobId);
                if (!job) {
                    this.snapshotCache.delete(jobId);
                    continue;
                }
                this.snapshotCache.set(jobId, job.toSnapshot());
            }

            this.dirtyJobs.clear();
            this.options?.persistJobs?.(Array.from(this.snapshotCache.values()));
        });
    }

    /**
     * Marks a job snapshot as dirty so it is refreshed on next persistence flush.
     *
     * @param jobId Job identifier
     */
    private markJobDirty(jobId: string) {
        this.dirtyJobs.add(jobId);
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
            subscriber(this.snapshotCache.get(job.id) ?? job.toSnapshot());
        }

        return () => this.subscribers.get(jobId)?.delete(subscriber);
    }

    /**
     * Notifies all subscribers of a job's status update.
     *
     * @param jobId The job ID
     */
    private notifySubscribers(jobId: string, snapshotOverride?: JobSnapshot<any, any>) {
        const job = this.jobs.get(jobId);
        if (!job) {
            return;
        }
        const subs = this.subscribers.get(jobId);
        if (!subs) {
            return;
        }

        const snapshot = snapshotOverride ?? this.snapshotCache.get(job.id) ?? job.toSnapshot();
        for (const sub of subs) {
            sub(snapshot);
        }
    }
}
