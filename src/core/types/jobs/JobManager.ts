import { GenericJob, JobChunk, JobSnapshot, MultiModalExecutionContext } from "#root/index.js";

interface QueuedJob<TInput, TOutput> {
    job: GenericJob<TInput, TOutput>;
    ctx: MultiModalExecutionContext;
}

interface JobManagerOptions {
    maxConcurrency?: number;
    hooks?: JobManagerHooks;

    /** Optional persistence hooks */
    persistJobs?: (snapshots: JobSnapshot<any, any>[]) => void;
    loadPersistedJobs?: () => JobSnapshot<any, any>[];
}

type JobSubscriber<TInput, TOutput> = (snapshot: JobSnapshot<TInput, TOutput>) => void;

export interface JobManagerHooks {
    onStart?: (job: JobSnapshot<any, any>) => void;
    onProgress?: (chunk: JobChunk<any>, job: JobSnapshot<any, any>) => void;
    onComplete?: (job: JobSnapshot<any, any>) => void;
    onError?: (error: Error, job: JobSnapshot<any, any>) => void;
}

export class JobManager {
    private jobs: Map<string, GenericJob<any, any>> = new Map();
    private controllers: Map<string, AbortController> = new Map();
    private subscribers = new Map<string, Set<JobSubscriber<any, any>>>();
    private jobQueue: QueuedJob<any, any>[] = [];
    private runningCount: number = 0;

    constructor(private options?: JobManagerOptions) {
        // Restore persisted jobs
        if (options?.loadPersistedJobs) {
            const snapshots = options.loadPersistedJobs();
            for (const snap of snapshots) {
                const job = new GenericJob<any, any>(snap.input, snap.streaming?.enabled ?? false, async () => snap.output);
                job.id = snap.id as any;
                job.status = snap.status === "running" ? "interrupted" : snap.status;
                job.output = snap.output;
                job.error = snap.error ? new Error(snap.error) : undefined;
                this.jobs.set(job.id, job);
            }
        }
    }

    addJob<TInput, TOutput>(job: GenericJob<TInput, TOutput>) {
        if (this.jobs.has(job.id)) throw new Error(`Job with id ${job.id} already exists`);

        // Auto-persist on status change
        job.onStatusChange = () => {
            this.persist();
            this.notifySubscribers(job.id);
        };

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
        const job = this.getJob<TInput, TOutput>(id);
        if (!job) throw new Error(`Job ${id} not found`);
        job.onChunk = onChunk;

        this.jobQueue.push({ job, ctx });
        this.processQueue();
        return job;
    }

    private processQueue() {
        while (this.runningCount < (this.options?.maxConcurrency ?? Infinity) && this.jobQueue.length > 0) {
            const { job, ctx } = this.jobQueue.shift()!;
            this.runningCount++;

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
            job.run(ctx, controller.signal, chunkCallback);

            // Lifecycle via completion promise - ensures hooks are called even if job.run() throws or doesn't properly update status
            job.getCompletionPromise()
                .then(() => {
                    this.options?.hooks?.onComplete?.(job.toSnapshot());
                })
                .catch(err => {
                    this.options?.hooks?.onError?.(err, job.toSnapshot());
                })
                .finally(() => {
                    this.controllers.delete(job.id);
                    this.runningCount--;
                    this.persist();
                    this.notifySubscribers(job.id);
                    this.processQueue();
                });
        }
    }

    abortJob(id: string, reason?: string) {
        const job = this.getJob(id);
        if (!job) throw new Error(`Job ${id} not found`);

        const controller = this.controllers.get(id);
        if (controller) {
            // AbortController.signal.reason can be passed via a new Error
            controller.abort(new Error(reason ?? "Job aborted"));
        }

        // Update job status and notify subscribers
        job.status = "aborted";
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
