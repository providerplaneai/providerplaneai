import { Job, JobChunk, JobLifecycleHooks, JobSnapshot, JobStatus, MultiModalExecutionContext, TimelineArtifacts } from "#root/index.js";

export class GenericJob<TInput, TOutput> implements Job<TInput, TOutput> {
    id = crypto.randomUUID();
    output?: TOutput;
    error?: Error;
    private artifacts: TimelineArtifacts = {};
    private _status: JobStatus = "pending";

    /** Completion promise (never blocks unless awaited externally) */
    private completionPromise: Promise<TOutput>;
    private resolveCompletion!: (value: TOutput) => void;
    private rejectCompletion!: (err: Error) => void;

    /** Called whenever status changes */
    onStatusChange?: (status: JobStatus) => void;

    /** Optional streaming callback */
    onChunk?: (chunk: JobChunk<TOutput>) => void;

    /** Streaming snapshot state */
    private streamingStarted = false;
    private streamingCompleted = false;
    private chunksEmitted: number = 0;
    private lastChunkAt?: number;

    /** Index into ctx.timeline up to which artifacts have been synced */
    private timelineIndexCursor = 0;

    /** Timing metrics */
    private startTime?: number;
    private endTime?: number;

    constructor(
        public input: TInput,
        private streamingEnabled: boolean = false,
        private executor: (
            input: TInput,
            ctx: MultiModalExecutionContext,
            signal?: AbortSignal,
            onChunk?: (chunk: JobChunk<TOutput>) => void
        ) => Promise<TOutput>,
        private hooks?: JobLifecycleHooks<TOutput>
    ) {
        this.completionPromise = new Promise<TOutput>((resolve, reject) => {
            this.resolveCompletion = resolve;
            this.rejectCompletion = reject;
        });
    }

    get status() { return this._status; }
    set status(newStatus: JobStatus) {
        this._status = newStatus;
        this.onStatusChange?.(newStatus);
    }

    get durationMs() {
        if (this.startTime && this.endTime) return this.endTime - this.startTime;
        if (this.startTime) return Date.now() - this.startTime;
        return undefined;
    }

    getCompletionPromise(): Promise<TOutput> {
        return this.completionPromise;
    }

    /**
     * Run the job.
     * NOTE: Consumers should typically call JobManager.runJob() instead of invoking this directly, 
     * to ensure proper concurrency management, hooks, and persistence.
     * 
     * @param ctx MultiModalExecutionContext
     * @param signal Optional abort signal
     * @param onChunk Optional streaming callback (overrides existing onChunk)
     */
    async run(ctx: MultiModalExecutionContext, signal?: AbortSignal, onChunk?: (chunk: JobChunk<TOutput>) => void): Promise<void> {
        if (this.status === "completed" || this.status === "error" || this.status === "aborted") {
            // final states cannot rerun
            return;
        }

        this.status = "running";
        this.startTime = Date.now();
        this.hooks?.onStart?.();

        const chunkCallback = onChunk ?? this.onChunk;

        try {
            const wrappedChunkCallback = (chunk: JobChunk<TOutput>) => {
                this.syncArtifactsFromTimeline(ctx);

                // Update streaming metadata
                if (this.streamingEnabled) {
                    if (!this.streamingStarted) this.streamingStarted = true;
                    this.chunksEmitted++;
                    this.lastChunkAt = Date.now();
                    if (chunk.final) this.streamingCompleted = true;
                }

                // Call user-provided chunk callback
                chunkCallback?.(chunk);
            };

            const response = await this.executor(this.input, ctx, signal, wrappedChunkCallback);
            this.output = response;
            this.syncArtifactsFromTimeline(ctx);
            this.status = "completed";
            this.endTime = Date.now();
            this.hooks?.onComplete?.(response);
            this.resolveCompletion(response);
        } catch (err: any) {
            this.error = err;
            this.status = signal?.aborted ? "aborted" : "error";
            this.endTime = Date.now();
            this.hooks?.onError?.(err);
            this.rejectCompletion(err);
        }
    }

    toSnapshot(): JobSnapshot<TInput, TOutput> {
        return {
            id: this.id,
            status: this.status,
            input: this.input,
            output: this.output,
            error: this.error?.message,
            multimodalArtifacts: { ...this.artifacts },
            durationMs: this.durationMs,
            streaming: this.streamingEnabled
                ? {
                    enabled: true,
                    started: this.streamingStarted,
                    chunksEmitted: this.chunksEmitted,
                    completed: this.streamingCompleted,
                    lastChunkAt: this.lastChunkAt
                }
                : undefined
        };
    }

    private syncArtifactsFromTimeline(ctx: MultiModalExecutionContext) {
        const timeline = ctx.getTimeline();

        for (let i = this.timelineIndexCursor; i < timeline.length; i++) {
            const event = timeline[i];
            const artifacts = event.artifacts;
            if (!artifacts) continue;

            for (const key of Object.keys(artifacts) as (keyof TimelineArtifacts)[]) {
                const arr = artifacts[key];
                if (!arr || arr.length === 0) continue;

                if (!this.artifacts[key]) {
                    this.artifacts[key] = [];
                }

                (this.artifacts[key] as unknown[]).push(...arr);
            }
        }

        this.timelineIndexCursor = timeline.length;
    }


    isPending() { return this.status === "pending"; }
    isRunning() { return this.status === "running"; }
    isCompleted() { return this.status === "completed"; }
    isErrored() { return this.status === "error"; }
    isAborted() { return this.status === "aborted"; }
}        
