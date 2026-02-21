import { GenericJob, JobChunk, JobFactory, JobSnapshot, MultiModalExecutionContext } from "#root/index.js";

type JobSubscriber<TInput, TOutput> = (snapshot: JobSnapshot<TInput, TOutput>) => void;

interface QueuedJob<TInput, TOutput> {
    job: GenericJob<TInput, TOutput>;
    ctx: MultiModalExecutionContext;
}

export interface JobManagerHooks {
    onStart?: (job: JobSnapshot<any, any>) => void;
    onProgress?: (chunk: JobChunk<any>, job: JobSnapshot<any, any>) => void;
    onComplete?: (job: JobSnapshot<any, any>) => void;
    onError?: (error: Error, job: JobSnapshot<any, any>) => void;
}

export interface JobManagerOptions {
    maxConcurrency?: number;
    maxStoredResponseChunks?: number;
    hooks?: JobManagerHooks;

    /** Optional persistence hooks */
    persistJobs?: (snapshots: JobSnapshot<any, any>[]) => void;
    loadPersistedJobs?: () => JobSnapshot<any, any>[];

    jobFactory?: JobFactory<any, any>;
}

export class JobManager {
    private jobs: Map<string, GenericJob<any, any>> = new Map();
    private controllers: Map<string, AbortController> = new Map();
    private subscribers = new Map<string, Set<JobSubscriber<any, any>>>();
    private jobQueue: QueuedJob<any, any>[] = [];
    private runningCount: number = 0;

    constructor(private options?: JobManagerOptions) {
        this.setMaxConcurrency(this.options?.maxConcurrency);
        this.setMaxStoredResponseChunks(this.options?.maxStoredResponseChunks);

        // Restore persisted jobs
        this.restorePersistedJobs();
    }

    getMaxConcurrency(): number | undefined {
        return this.options?.maxConcurrency;
    }

    setMaxConcurrency(maxConcurrency: number | undefined) {
        if (maxConcurrency !== undefined && (!Number.isInteger(maxConcurrency) || maxConcurrency < 0)) {
            throw new Error("JobManager: maxConcurrency must be a non-negative integer");
        }
        this.options = this.options ?? {};
        this.options.maxConcurrency = maxConcurrency;
    }

    getMaxStoredResponseChunks(): number | undefined {
        return this.options?.maxStoredResponseChunks;
    }

    setMaxStoredResponseChunks(maxStoredResponseChunks: number | undefined) {
        if (maxStoredResponseChunks !== undefined && (!Number.isInteger(maxStoredResponseChunks) || maxStoredResponseChunks < 0)) {
            throw new Error("JobManager: maxStoredResponseChunks must be a non-negative integer");
        }
        this.options = this.options ?? {};
        this.options.maxStoredResponseChunks = maxStoredResponseChunks;
    }

    getQueueLength(): number {
        return this.jobQueue.length;
    }

    getRunningCount(): number {
        return this.runningCount;
    }

    private wireJob<TInput, TOutput>(job: GenericJob<TInput, TOutput>) {
        const existingStatusHandler = job.onStatusChange;
        job.onStatusChange = (status) => {
            existingStatusHandler?.(status);
            this.persist();
            this.notifySubscribers(job.id);
        };
    }

    private restorePersistedJobs() {
        if (!this.options?.loadPersistedJobs) return;

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
                            throw new Error(
                                `Restored job '${snap.id}' cannot be executed: ${message}`
                            );
                        },
                        undefined,
                        this.options?.maxStoredResponseChunks,
                        { capability: snap.capability, providerChain: snap.providerChain }
                    );
                }
            } else {
                job = new GenericJob<any, any>(snap.input, snap.streaming?.enabled ?? false,
                    async () => { throw new Error("Restored job cannot be executed"); },
                    undefined,
                    this.options?.maxStoredResponseChunks,
                    { capability: snap.capability, providerChain: snap.providerChain });
            }
            job.restoreFromSnapshot(snap);
            this.wireJob(job);

            this.jobs.set(job.id, job);
        }
    }    

    addJob<TInput, TOutput>(job: GenericJob<TInput, TOutput>) {
        if (this.jobs.has(job.id)) throw new Error(`JobManager: job '${job.id}' already exists`);

        this.wireJob(job);

        this.jobs.set(job.id, job);
        this.persist();
    }

    getJob<TInput, TOutput>(id: string): GenericJob<TInput, TOutput> | undefined {
        return this.jobs.get(id) as GenericJob<TInput, TOutput> | undefined;
    }

    runJob<TInput, TOutput>(
        id: string,
        ctx: MultiModalExecutionContext,
        onChunk?: (chunk: JobChunk<TOutput>) => void
    ): GenericJob<TInput, TOutput> {
        if (this.options?.maxConcurrency === 0) {
            throw new Error("JobManager: maxConcurrency is 0; job execution is disabled");
        }
        const job = this.getJob<TInput, TOutput>(id);
        if (!job) throw new Error(`JobManager: job '${id}' not found`);
        if (job.status === "running") throw new Error(`JobManager: job '${id}' is already running`);
        if (this.jobQueue.some(q => q.job.id === id)) throw new Error(`JobManager: job '${id}' is already queued`);
        job.onChunk = onChunk;

        this.jobQueue.push({ job, ctx });
        this.processQueue();
        return job;
    }

    rerunJob<TInput, TOutput>(
        id: string,
        ctx: MultiModalExecutionContext,
        onChunk?: (chunk: JobChunk<TOutput>) => void
    ): GenericJob<TInput, TOutput> {
        const job = this.getJob<TInput, TOutput>(id);
        if (!job) throw new Error(`JobManager: job '${id}' not found`);
        if(job.status === "running") throw new Error(`JobManager: job '${id}' is running and cannot be rerun`);

        // Reset job state
        job.reset();

        this.runJob(id, ctx, onChunk);
        return job;
    }

    private processQueue() {
        while (this.runningCount < (this.options?.maxConcurrency ?? Infinity) && this.jobQueue.length > 0) {
            const { job, ctx } = this.jobQueue.shift()!;
            this.runningCount++;
            let finalized = false;
            const finalize = () => {
                if (finalized) return;
                finalized = true;
                this.controllers.delete(job.id);
                this.runningCount--;
                this.persist();
                this.notifySubscribers(job.id);
                this.processQueue();
            };

            // Create per-job controller
            const controller = new AbortController();
            this.controllers.set(job.id, controller);

            this.options?.hooks?.onStart?.(job.toSnapshot());

            const chunkCallback = (chunk: JobChunk<any>) => {
                job.onChunk?.(chunk);
                this.options?.hooks?.onProgress?.(chunk, job.toSnapshot());
                this.notifySubscribers(job.id);
            };

            // Fire and forget - job will update its own status and notify subscribers/hooks on completion/error
            const runPromise = job.run(ctx, controller.signal, chunkCallback);

            // Lifecycle via completion promise - ensures hooks are called even if job.run() throws or doesn't properly update status
            job.getCompletionPromise()
                .then(() => {
                    this.options?.hooks?.onComplete?.(job.toSnapshot());
                })
                .catch(err => {
                    this.options?.hooks?.onError?.(err, job.toSnapshot());
                })
                .finally(finalize);

            // Guard against unexpected run-time exceptions (e.g. hook throws before completionPromise is settled).
            runPromise.catch(err => {
                const normalized = err instanceof Error ? err : new Error(String(err));
                this.options?.hooks?.onError?.(normalized, job.toSnapshot());
                finalize();
            });
        }
    }

    abortJob(id: string, reason?: string) {
        const job = this.getJob(id);
        if (!job) throw new Error(`JobManager: job '${id}' not found`);

        // Remove queued entries so aborted pending jobs do not execute later.
        this.jobQueue = this.jobQueue.filter(q => q.job.id !== id);

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

    listJobs(): JobSnapshot<any, any>[] {
        return Array.from(this.jobs.values()).map(j => j.toSnapshot());
    }

    private persist() {
        if (this.options?.persistJobs) {
            this.options.persistJobs(this.listJobs());
        }
    }

    subscribe<TInput, TOutput>(jobId: string, subscriber: JobSubscriber<TInput, TOutput>) {
        if (!this.subscribers.has(jobId)) this.subscribers.set(jobId, new Set());
        this.subscribers.get(jobId)!.add(subscriber);

        const job = this.jobs.get(jobId);
        if (job) subscriber(job.toSnapshot());

        return () => this.subscribers.get(jobId)?.delete(subscriber);
    }

    private notifySubscribers<TInput, TOutput>(jobId: string) {
        const job = this.jobs.get(jobId);
        if (!job) return;
        const subs = this.subscribers.get(jobId);
        if (!subs) return;

        const snapshot = job.toSnapshot();
        for (const sub of subs) sub(snapshot);
    }
}
