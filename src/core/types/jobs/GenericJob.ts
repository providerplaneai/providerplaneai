import {
    AIResponse,
    AIResponseChunk,
    CapabilityKeyType,
    Job,
    JobChunk,
    JobLifecycleHooks,
    JobSnapshot,
    JobStatus,
    MultiModalExecutionContext,
    ProviderRef,
    sanitizeTimelineArtifacts,
    stripBinaryPayloadFields,
    TimelineArtifacts
} from "#root/index.js";

/**
 * GenericJob manages the lifecycle, execution, and state of an AI job, supporting streaming and non-streaming modes.
 * Handles input, output, error, status, artifacts, and raw response management, with hooks for orchestration.
 * @template TInput The input type for the job.
 * @template TOutput The output type for the job.
 */
export class GenericJob<TInput, TOutput> implements Job<TInput, TOutput> {
    private readonly maxStoredResponseChunks: number;
    private readonly capability?: CapabilityKeyType;
    private readonly providerChain?: ProviderRef[];
    private readonly storeRawResponses: boolean;
    private readonly maxRawBytesPerJob?: number;
    private readonly stripBinaryPayloadsInSnapshotsAndTimeline: boolean;

    private _id = crypto.randomUUID();
    private _output?: TOutput;
    private _error?: Error;

    private _status: JobStatus = "pending";

    private _response?: AIResponse<TOutput>;
    private _responseChunks: AIResponseChunk<TOutput>[] = [];

    /** Artifacts accumulated during job execution */
    private artifacts: TimelineArtifacts = {};
    private artifactSeen = new Map<keyof TimelineArtifacts, Set<string>>();

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

    /** Timing metrics */
    private startTime?: number;
    private endTime?: number;
    private runCount = 0;
    private restoredFromSnapshotAt?: number;
    private rawBytesStored = 0;
    private rawPayloadsDropped = 0;
    private rawBytesDropped = 0;

    /**
     * Constructs a new GenericJob instance.
     * @param input The job input.
     * @param streamingEnabled Whether streaming is enabled for this job.
     * @param executor The function to execute the job.
     * @param hooks Optional lifecycle hooks.
     * @param maxStoredResponseChunks Max number of response chunks to store.
     * @param executionMetadata Optional metadata for execution (capability, provider chain, etc).
     */
    constructor(
        public readonly input: TInput,
        private streamingEnabled: boolean = false,
        private executor: (
            input: TInput,
            ctx: MultiModalExecutionContext,
            signal?: AbortSignal,
            onChunk?: (chunk: JobChunk<TOutput>, internalChunk?: AIResponseChunk<TOutput>) => void
        ) => Promise<AIResponse<TOutput>>,
        private hooks?: JobLifecycleHooks<TOutput>,
        maxStoredResponseChunks?: number,
        executionMetadata?: {
            capability?: CapabilityKeyType;
            providerChain?: ProviderRef[];
            storeRawResponses?: boolean;
            maxRawBytesPerJob?: number;
            stripBinaryPayloadsInSnapshotsAndTimeline?: boolean;
        }
    ) {
        if (
            maxStoredResponseChunks !== undefined &&
            (!Number.isInteger(maxStoredResponseChunks) || maxStoredResponseChunks < 0)
        ) {
            throw new Error("GenericJob: maxStoredResponseChunks must be a non-negative integer");
        }
        if (
            executionMetadata?.maxRawBytesPerJob !== undefined &&
            (!Number.isInteger(executionMetadata.maxRawBytesPerJob) || executionMetadata.maxRawBytesPerJob < 0)
        ) {
            throw new Error("GenericJob: maxRawBytesPerJob must be a non-negative integer");
        }
        this.maxStoredResponseChunks = maxStoredResponseChunks ?? 1000;
        this.capability = executionMetadata?.capability;
        this.providerChain = executionMetadata?.providerChain;
        this.storeRawResponses = executionMetadata?.storeRawResponses ?? true;
        this.maxRawBytesPerJob = executionMetadata?.maxRawBytesPerJob;
        this.stripBinaryPayloadsInSnapshotsAndTimeline =
            executionMetadata?.stripBinaryPayloadsInSnapshotsAndTimeline ?? false;
        this.completionPromise = new Promise<TOutput>((resolve, reject) => {
            this.resolveCompletion = resolve;
            this.rejectCompletion = reject;
        });
    }

    get id() {
        return this._id;
    }
    get output() {
        return this._output;
    }
    get error() {
        return this._error;
    }

    /** Internal diagnostic view of final orchestration response (read-only). */
    get response(): AIResponse<TOutput> | undefined {
        return this._response;
    }

    /** Internal diagnostic view of orchestration chunks (read-only snapshot copy). */
    get responseChunks(): readonly AIResponseChunk<TOutput>[] {
        return this._responseChunks.slice();
    }

    get status() {
        return this._status;
    }
    private setStatus(newStatus: JobStatus) {
        this._status = newStatus;
        this.onStatusChange?.(newStatus);
    }

    get durationMs() {
        if (this.startTime && this.endTime) {
            return this.endTime - this.startTime;
        }
        if (this.startTime) {
            return Date.now() - this.startTime;
        }
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
    async run(
        ctx: MultiModalExecutionContext,
        signal?: AbortSignal,
        onChunk?: (chunk: JobChunk<TOutput>) => void
    ): Promise<void> {
        if (this.status === "running") {
            // Can only rerun a job if it's not currently running
            return;
        }

        this.runCount++;
        this.setStatus("running");
        this.startTime = Date.now();

        const chunkCallback = onChunk ?? this.onChunk;

        try {
            this.hooks?.onStart?.();

            const wrappedChunkCallback = (chunk: JobChunk<TOutput>, internalChunk?: AIResponseChunk<TOutput>) => {
                if (internalChunk) {
                    const chunkToStore = {
                        ...internalChunk,
                        raw: this.storeRawResponses ? this.applyRawByteBudget(internalChunk.raw) : undefined
                    };
                    this._responseChunks.push(chunkToStore);
                    if (this._responseChunks.length > this.maxStoredResponseChunks) {
                        this._responseChunks.splice(0, this._responseChunks.length - this.maxStoredResponseChunks);
                    }
                    this.mergeArtifacts(internalChunk.multimodalArtifacts);
                }

                // Update streaming metadata based on public JobChunk emissions.
                if (this.streamingEnabled) {
                    this.streamingStarted = true;
                    this.chunksEmitted++;
                    this.lastChunkAt = Date.now();
                    if (chunk.final) {
                        this.streamingCompleted = true;
                    }
                }

                // Call user-provided chunk callback
                chunkCallback?.(chunk);
            };

            const response = await this.executor(this.input, ctx, signal, wrappedChunkCallback);
            this._response = {
                ...response,
                rawResponse: this.storeRawResponses ? this.applyRawByteBudget(response.rawResponse) : undefined,
                metadata: {
                    ...(response.metadata ?? {}),
                    rawPayloadDropped: this.rawPayloadsDropped > 0,
                    rawPayloadDroppedCount: this.rawPayloadsDropped,
                    rawPayloadDroppedBytes: this.rawBytesDropped,
                    rawPayloadStoredBytes: this.rawBytesStored
                }
            };
            this._output = response.output;
            this.mergeArtifacts(response.multimodalArtifacts);
            this.setStatus("completed");
            this.endTime = Date.now();
            this.hooks?.onComplete?.(response.output);
            this.resolveCompletion(response.output);
        } catch (err: any) {
            this._error = err;
            this.setStatus(signal?.aborted ? "aborted" : "error");
            this.endTime = Date.now();
            this.hooks?.onError?.(err);
            this.rejectCompletion(err);
        }
    }

    toSnapshot(): JobSnapshot<TInput, TOutput> {
        const output = this.stripBinaryPayloadsInSnapshotsAndTimeline
            ? stripBinaryPayloadFields(this.output)
            : this.output;
        const multimodalArtifacts = this.stripBinaryPayloadsInSnapshotsAndTimeline
            ? (sanitizeTimelineArtifacts(this.artifacts) as TimelineArtifacts)
            : ({ ...this.artifacts } as TimelineArtifacts);

        return {
            schemaVersion: 1,
            id: this.id,
            capability: this.capability,
            providerChain: this.providerChain,
            status: this.status,
            input: this.input,
            output,
            error: this._error?.message,
            multimodalArtifacts,
            startedAt: this.startTime,
            endedAt: this.endTime,
            runCount: this.runCount,
            restoredFromSnapshotAt: this.restoredFromSnapshotAt,
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

    reset() {
        this._output = undefined;
        this._error = undefined;
        this._response = undefined;
        this._responseChunks = [];
        this.setStatus("pending");
        this.artifacts = {};
        this.artifactSeen.clear();
        this.streamingStarted = false;
        this.streamingCompleted = false;
        this.chunksEmitted = 0;
        this.lastChunkAt = undefined;
        this.rawBytesStored = 0;
        this.rawPayloadsDropped = 0;
        this.rawBytesDropped = 0;
        this.startTime = undefined;
        this.endTime = undefined;
        this.restoredFromSnapshotAt = undefined;
        this.completionPromise = new Promise<TOutput>((resolve, reject) => {
            this.resolveCompletion = resolve;
            this.rejectCompletion = reject;
        });
    }

    /**
     * Hydrate this job from a persisted snapshot.
     * Internal response envelopes/chunks are intentionally not restored because
     * rerun semantics are deterministic replay from input + executor, not raw resume.
     */
    restoreFromSnapshot(snapshot: JobSnapshot<TInput, TOutput>) {
        this._id = snapshot.id as any;
        this._output = snapshot.output;
        this._error = snapshot.error ? new Error(snapshot.error) : undefined;
        this.setStatus(snapshot.status === "running" ? "interrupted" : snapshot.status);

        this.artifacts = this.stripBinaryPayloadsInSnapshotsAndTimeline
            ? ((sanitizeTimelineArtifacts(snapshot.multimodalArtifacts) ?? {}) as TimelineArtifacts)
            : { ...(snapshot.multimodalArtifacts ?? {}) };
        this.rebuildArtifactSeen();
        this.startTime = snapshot.startedAt;
        this.endTime = snapshot.endedAt;
        this.runCount = snapshot.runCount ?? 0;
        this.restoredFromSnapshotAt = Date.now();

        this.streamingEnabled = snapshot.streaming?.enabled ?? this.streamingEnabled;
        this.streamingStarted = snapshot.streaming?.started ?? false;
        this.chunksEmitted = snapshot.streaming?.chunksEmitted ?? 0;
        this.streamingCompleted = snapshot.streaming?.completed ?? false;
        this.lastChunkAt = snapshot.streaming?.lastChunkAt;

        this._response = undefined;
        this._responseChunks = [];
        this.rawBytesStored = 0;
        this.rawPayloadsDropped = 0;
        this.rawBytesDropped = 0;
    }

    markAborted(reason?: Error) {
        // Preserve the first meaningful abort reason when provided by caller/manager.
        if (reason) {
            this._error = reason;
        }
        this.setStatus("aborted");
        if (!this.endTime) {
            this.endTime = Date.now();
        }
    }

    private mergeArtifacts(artifacts?: TimelineArtifacts) {
        if (!artifacts) {
            return;
        }
        if (this.stripBinaryPayloadsInSnapshotsAndTimeline) {
            artifacts = (sanitizeTimelineArtifacts(artifacts) ?? {}) as TimelineArtifacts;
        }

        for (const key of Object.keys(artifacts) as (keyof TimelineArtifacts)[]) {
            const incoming = artifacts[key];
            if (!incoming || incoming.length === 0) {
                continue;
            }

            if (!this.artifacts[key]) {
                this.artifacts[key] = [];
            }

            const target = this.artifacts[key] as unknown[];
            for (const item of incoming) {
                const fingerprint = this.getArtifactFingerprint(item);
                if (!fingerprint) {
                    // Artifacts without stable IDs are appended as-is.
                    target.push(item);
                    continue;
                }

                let seen = this.artifactSeen.get(key);
                if (!seen) {
                    seen = new Set<string>();
                    this.artifactSeen.set(key, seen);
                }

                if (seen.has(fingerprint)) {
                    continue;
                }

                seen.add(fingerprint);
                target.push(item);
            }
        }
    }

    private rebuildArtifactSeen() {
        this.artifactSeen.clear();

        for (const key of Object.keys(this.artifacts) as (keyof TimelineArtifacts)[]) {
            const arr = this.artifacts[key];
            if (!arr || arr.length === 0) {
                continue;
            }

            for (const item of arr) {
                const fingerprint = this.getArtifactFingerprint(item);
                if (!fingerprint) {
                    continue;
                }

                let seen = this.artifactSeen.get(key);
                if (!seen) {
                    seen = new Set<string>();
                    this.artifactSeen.set(key, seen);
                }
                seen.add(fingerprint);
            }
        }
    }

    private getArtifactFingerprint(value: unknown): string | undefined {
        if (!value || typeof value !== "object") {
            return undefined;
        }

        const id = (value as { id?: unknown }).id;
        if (typeof id === "string" && id.length > 0) {
            return `id:${id}`;
        }

        return undefined;
    }

    private applyRawByteBudget(raw: unknown): unknown | undefined {
        if (raw === undefined) {
            return undefined;
        }
        if (this.maxRawBytesPerJob === undefined) {
            return raw;
        }

        const rawBytes = this.estimateRawBytes(raw);
        if (rawBytes === undefined) {
            // Unmeasurable payloads are dropped to keep accounting deterministic.
            return undefined;
        }

        if (this.rawBytesStored + rawBytes > this.maxRawBytesPerJob) {
            this.rawPayloadsDropped++;
            this.rawBytesDropped += rawBytes;
            return undefined;
        }

        this.rawBytesStored += rawBytes;
        return raw;
    }

    private estimateRawBytes(raw: unknown): number | undefined {
        if (raw === undefined || raw === null) {
            return 0;
        }
        if (typeof raw === "string") {
            return Buffer.byteLength(raw);
        }
        if (Buffer.isBuffer(raw)) {
            return raw.byteLength;
        }
        if (ArrayBuffer.isView(raw)) {
            return raw.byteLength;
        }
        if (raw instanceof ArrayBuffer) {
            return raw.byteLength;
        }
        if (typeof raw === "number" || typeof raw === "boolean" || typeof raw === "bigint") {
            return Buffer.byteLength(String(raw));
        }
        if (typeof raw === "object") {
            try {
                return Buffer.byteLength(JSON.stringify(raw));
            } catch {
                return undefined;
            }
        }

        return undefined;
    }

    isPending() {
        return this.status === "pending";
    }
    isRunning() {
        return this.status === "running";
    }
    isCompleted() {
        return this.status === "completed";
    }
    isErrored() {
        return this.status === "error";
    }
    isAborted() {
        return this.status === "aborted";
    }
}
