import {
    AIProvider,
    AIProviderType,
    AIRequest,
    AIResponse,
    AIResponseChunk,
    AppConfig,
    BaseProvider,
    CapabilityKeys,
    loadAppConfig,
    MultiModalExecutionContext,
    ProviderRef,
    withRequestContext,
    withRequestContextStream,
    AIClientLifecycleHooks,
    AllProvidersFailedError,
    AnthropicProvider,
    DuplicateProviderRegistrationError,
    ExecutionPolicyError,
    GeminiProvider,
    NormalizedImage,
    NormalizedImageAnalysis,
    OpenAIProvider,
    ProviderAttemptContext,
    ProviderAttemptResult,
    NormalizedModeration,
    NormalizedChatMessage,
    NormalizedEmbedding,
    NormalizedUserInput,
    TimelineArtifacts,
    BuiltInCapabilityKey,
    CustomCapabilityKey,
    CapabilityKeyType,
    GenericJob,
    JobManager,
    JobLifecycleHooks,
    createDefaultExecutors,
    CapabilityExecutorRegistry,
    CapabilityExecutor,
    NonStreamingExecutor,
    StreamingExecutor
} from "#root/index.js";

/**
 * Main orchestrator and entry point for ProviderPlaneAI consumers.
 *
 * Responsibilities:
 * - Load and manage application configuration
 * - Register, initialize, and route to AI providers
 * - Enforce capability availability and fail-fast error handling
 * - Manage session lifecycle and event timelines
 * - Provide job-first, provider-agnostic orchestration for all capabilities
 *
 * Design:
 * - No provider-specific logic or AI implementation details
 * - Providers are opaque containers of capabilities
 * - Focuses on orchestration, error handling, and capability-based routing
 *
 * Usage:
 *   Instantiate once, register providers, and use for all AI requests and session management.
 */
export class AIClient {
    /**
     * Provider registry:
     *   Provider type (e.g. OpenAI, Anthropic)
     *     → connection name (e.g. "default", "prod", "staging")
     *       → provider instance
     * Allows multiple credentials or environments per provider.
     */
    private providers: Map<AIProviderType, Map<string, BaseProvider>> = new Map();

    private executors: CapabilityExecutorRegistry;

    /**
     * Application configuration loaded from config files and environment variables.
     * Resolved once at construction and passed to providers during initialization.
     * AIClient does not interpret provider-specific config.
     */
    private appConfig: AppConfig;

    /** Optional lifecycle hooks for metrics and instrumentation */
    private lifeCycleHooks?: AIClientLifecycleHooks;
    private _jobManager: JobManager;

    constructor(jobManager?: JobManager, executors?: CapabilityExecutorRegistry) {
        const appConfig = loadAppConfig();
        this.appConfig = appConfig;
        const configuredMaxConcurrency = appConfig.appConfig?.maxConcurrency;
        const configuredMaxQueueSize = appConfig.appConfig?.maxQueueSize;
        const configuredMaxStoredResponseChunks = appConfig.appConfig?.maxStoredResponseChunks;
        const configuredStoreRawResponses = appConfig.appConfig?.storeRawResponses;
        const configuredMaxRawBytesPerJob = appConfig.appConfig?.maxRawBytesPerJob;

        if (jobManager) {
            if (jobManager.getMaxConcurrency() === undefined) {
                jobManager.setMaxConcurrency(configuredMaxConcurrency);
            }
            if (jobManager.getMaxQueueSize() === undefined) {
                jobManager.setMaxQueueSize(configuredMaxQueueSize);
            }
            if (jobManager.getMaxStoredResponseChunks() === undefined) {
                jobManager.setMaxStoredResponseChunks(configuredMaxStoredResponseChunks);
            }
            if (jobManager.getStoreRawResponses() === undefined) {
                jobManager.setStoreRawResponses(configuredStoreRawResponses);
            }
            if (jobManager.getMaxRawBytesPerJob() === undefined) {
                jobManager.setMaxRawBytesPerJob(configuredMaxRawBytesPerJob);
            }
            this._jobManager = jobManager;
        } else {
            this._jobManager = new JobManager({
                maxConcurrency: configuredMaxConcurrency,
                maxQueueSize: configuredMaxQueueSize,
                maxStoredResponseChunks: configuredMaxStoredResponseChunks,
                storeRawResponses: configuredStoreRawResponses,
                maxRawBytesPerJob: configuredMaxRawBytesPerJob
            });
        }

        // Auto-register providers from the provider chain
        for (const provider of appConfig?.appConfig?.executionPolicy?.providerChain || []) {
            const { connectionName, providerType } = provider;
            if (providerType === AIProvider.OpenAI) {
                this.registerProvider(new OpenAIProvider(), AIProvider.OpenAI, connectionName);
            } else if (providerType === AIProvider.Anthropic) {
                this.registerProvider(new AnthropicProvider(), AIProvider.Anthropic, connectionName);
            } else if (providerType === AIProvider.Gemini) {
                this.registerProvider(new GeminiProvider(), AIProvider.Gemini, connectionName);
            } else {
                throw new Error(`Invalid provider: ${providerType}`);
            }
        }

        this.executors = executors ?? createDefaultExecutors();
    }

    /**
     * Set lifecycle hooks for metrics and instrumentation.
     */
    setLifeCycleHooks(lifeCycleHooks: AIClientLifecycleHooks) {
        if (this.lifeCycleHooks) {
            throw new Error("Lifecycle hooks already set");
        }
        this.lifeCycleHooks = lifeCycleHooks;
    }

    /**
     * Registers and initializes a provider instance.
     *
     * Important invariants:
     * - A provider + connectionName pair may only be registered once
     * - Providers are initialized lazily at registration time
     * - Capability registration is the provider’s responsibility, not the client’s
     *
     * @param provider The provider instance to register
     * @param providerType The type of the provider (e.g. OpenAI, Anthropic)
     * @param connectionName Optional connection name; defaults to "default"
     * @throws Error if the provider + connectionName is already registered or missing config
     */
    public registerProvider(provider: BaseProvider, providerType: AIProviderType, connectionName: string = "default") {
        const providerMap = this.providers.get(providerType) || new Map();

        if (providerMap?.has(connectionName)) {
            throw new DuplicateProviderRegistrationError(providerType, connectionName);
        }

        // Providers manage their own lifecycle; AIClient only ensures init occurs once.
        const providerConfigs = this.appConfig.providers[providerType];
        if (!providerConfigs || !providerConfigs[connectionName]) {
            throw new ExecutionPolicyError(`Missing configuration for provider ${providerType} : (${connectionName})`);
        }

        if (!provider.isInitialized()) {
            provider.init(providerConfigs[connectionName]);
        }

        // Always register the provider instance after assuring initialization state
        providerMap.set(connectionName, provider);
        this.providers.set(providerType, providerMap);
        provider.setClientExecutors(
            this.executors?.getExecutors() ?? new Map<CapabilityKeyType, CapabilityExecutor<any, any, any>>()
        );
    }

    // overload — non-streaming
    public registerCapabilityExecutor<C extends BuiltInCapabilityKey, TInput, TOutput>(
        capability: C,
        executor: NonStreamingExecutor<C, TInput, TOutput>
    ): void;

    // overload — streaming
    public registerCapabilityExecutor<C extends BuiltInCapabilityKey, TInput, TOutput>(
        capability: C,
        executor: StreamingExecutor<C, TInput, TOutput>
    ): void;

    public registerCapabilityExecutor<TInput, TOutput>(
        capability: CustomCapabilityKey,
        executor: StreamingExecutor<any, TInput, TOutput> | NonStreamingExecutor<any, TInput, TOutput>
    ): void;

    public registerCapabilityExecutor<C extends CapabilityKeyType, TInput, TOutput>(
        capability: C,
        executor: StreamingExecutor<C, TInput, TOutput> | NonStreamingExecutor<C, TInput, TOutput>
    ) {
        if (this.executors.has(capability)) {
            throw new Error(`Executor for capability ${capability} is already registered`);
        }
        this.executors.set(capability, executor);

        for (const provider of this.providers.values()) {
            for (const p of provider.values()) {
                p.setClientExecutors(this.executors.getExecutors());
            }
        }
    }

    /**
     * Resolves a provider by type and connection name.
     *
     * This method intentionally throws hard errors:
     * - Missing providers are a configuration error, not a recoverable state
     *
     * @template T The type of the provider, typically a BaseProvider combined with a capability interface
     * @param type Provider type to resolve
     * @param connectionName Optional connection name; defaults to "default"
     * @returns The requested provider instance
     * @throws Error if the provider type or connection name is not registered
     */
    public getProvider<T extends BaseProvider>(type: AIProviderType, connectionName: string = "default"): T {
        const connections = this.providers.get(type);
        if (!connections) {
            throw new Error(`No providers registered for ${type}`);
        }

        const provider = connections.get(connectionName);
        if (!provider) {
            throw new Error(`No provider registered for ${type} with connection '${connectionName}'`);
        }

        return provider as T;
    }

    /**
     * Returns all registered providers that support a given capability.
     *
     * This method exists primarily for:
     * - Capability discovery
     * - Diagnostics and introspection
     * - Future agent planners and routers
     *
     * It does NOT perform routing or ranking.
     *
     * @template C Capability key type
     * @param capability The capability key to search for
     * @returns Array of providers that implement the requested capability
     */
    public findProvidersByCapability<C extends CapabilityKeyType>(capability: C): BaseProvider[] {
        const result: BaseProvider[] = [];
        for (const providerMap of this.providers.values()) {
            for (const provider of providerMap.values()) {
                if (provider.hasCapability(capability)) {
                    result.push(provider);
                }
            }
        }
        return result;
    }

    /**
     * Advanced access to the job manager.
     * Most consumers should create jobs via createCapabilityJob(...) and execute via this manager.
     */
    public get jobManager() {
        return this._jobManager;
    }

    /**
     * Primary execution API for consumers.
     * Creates a capability job that can be queued, observed, persisted, and rerun.
     */
    public createCapabilityJob<C extends CapabilityKeyType, TInput, TOutput>(
        capability: C,
        request: AIRequest<TInput>,
        options?: {
            maxStoredResponseChunks?: number;
            storeRawResponses?: boolean;
            maxRawBytesPerJob?: number;
            providerChain?: ProviderRef[];
            addToManager?: boolean;
            lifecycleHooks?: JobLifecycleHooks<TOutput>;
        }
    ): GenericJob<AIRequest<TInput>, TOutput> {
        const executor = this.executors.get<C, TInput, TOutput>(capability);

        const streaming: boolean = executor?.streaming;
        const maxStoredResponseChunks =
            options?.maxStoredResponseChunks ??
            this._jobManager.getMaxStoredResponseChunks() ??
            this.appConfig.appConfig?.maxStoredResponseChunks;
        const storeRawResponses =
            options?.storeRawResponses ??
            this._jobManager.getStoreRawResponses() ??
            this.appConfig.appConfig?.storeRawResponses ??
            true;
        const maxRawBytesPerJob =
            options?.maxRawBytesPerJob ??
            this._jobManager.getMaxRawBytesPerJob() ??
            this.appConfig.appConfig?.maxRawBytesPerJob;

        const job = new GenericJob<AIRequest<TInput>, TOutput>(
            request,
            streaming,
            async (input, ctx: MultiModalExecutionContext, signal, onChunk) => {
                if (executor.streaming === true) {
                    let finalOutput: TOutput | undefined;
                    let finalInternalChunk: AIResponseChunk<TOutput> | undefined;
                    let latestChunkId: string | undefined;
                    let latestChunkRaw: unknown;
                    let mergedMetadata: AIResponse<TOutput>["metadata"] | undefined;
                    const mergedArtifacts: TimelineArtifacts = {};

                    for await (const chunk of this.executeWithPolicyStream<C, TInput, TOutput>(
                        capability,
                        input,
                        ctx,
                        (provider, cctx, sig) => executor.invoke(provider.getCapability(capability), input, cctx, sig),
                        options?.providerChain
                    )) {
                        signal?.throwIfAborted();
                        if (chunk.id) {
                            latestChunkId = chunk.id;
                        }
                        if (chunk.raw !== undefined) {
                            latestChunkRaw = chunk.raw;
                        }
                        if (chunk.metadata) {
                            mergedMetadata = mergedMetadata ?? {};
                            Object.assign(mergedMetadata, chunk.metadata);
                        }
                        if (chunk.multimodalArtifacts) {
                            this.mergeTimelineArtifacts(mergedArtifacts, chunk.multimodalArtifacts);
                        }

                        if (chunk.delta !== undefined && onChunk) {
                            onChunk({ delta: chunk.delta }, chunk);
                        }

                        if (chunk.output !== undefined) {
                            finalOutput = chunk.output;
                            finalInternalChunk = chunk;
                        }
                    }

                    if (finalOutput !== undefined && onChunk) {
                        onChunk({ final: finalOutput }, finalInternalChunk ?? { output: finalOutput, done: true });
                    }
                    if (finalOutput === undefined) {
                        throw new Error(`AIClient: capability '${capability}' stream completed without final output`);
                    }
                    const fallbackArtifacts = this.buildArtifactsFromOutput(capability, finalOutput);
                    return {
                        output: finalOutput,
                        id: finalInternalChunk?.id ?? latestChunkId,
                        rawResponse: finalInternalChunk?.raw ?? latestChunkRaw,
                        multimodalArtifacts: Object.keys(mergedArtifacts).length ? mergedArtifacts : fallbackArtifacts,
                        metadata: {
                            ...(mergedMetadata ?? {}),
                            ...(finalInternalChunk?.metadata ?? {})
                        }
                    };
                } else {
                    const result = await this.executeWithPolicy<C, TInput, TOutput>(
                        capability,
                        input,
                        ctx,
                        (provider, cctx, sig) => executor.invoke(provider.getCapability(capability), input, cctx, sig),
                        options?.providerChain
                    );

                    if (result.multimodalArtifacts || result.output === undefined) {
                        return result;
                    }

                    return {
                        ...result,
                        multimodalArtifacts: this.buildArtifactsFromOutput(capability, result.output)
                    };
                }
            },
            options?.lifecycleHooks,
            maxStoredResponseChunks,
            {
                capability,
                providerChain: options?.providerChain,
                storeRawResponses,
                maxRawBytesPerJob
            }
        );

        if (options?.addToManager ?? true) {
            this._jobManager.addJob(job);
        }

        return job;
    }

    /**
     * Executes a capability call across a provider chain with fallback support.
     *
     * @template C Capability key (e.g., ChatCapability, ImageAnalysisCapability)
     * @param capability The capability being invoked
     * @param request The request object created by the caller
     * @param context The multimodal execution context to attach this request to
     * @param executeFn Function that executes the call on a provider
     * @param providerChain Optional ordered list of providers to try; defaults to appConfig.executionPolicy.providerChain
     * @returns Result of the first successful provider call
     * @throws AllProvidersFailedError if all providers fail
     */
    private async executeWithPolicy<C extends CapabilityKeyType, TReq, TRes>(
        capability: C,
        request: AIRequest<TReq>,
        context: MultiModalExecutionContext,
        executeFn: (provider: BaseProvider, ctx: MultiModalExecutionContext, signal?: AbortSignal) => Promise<AIResponse<TRes>>,
        providerChain?: ProviderRef[]
    ): Promise<AIResponse<TRes>> {
        // Use chain from config if none explicitly provided
        const chain: ProviderRef[] = providerChain ?? this.appConfig.appConfig?.executionPolicy?.providerChain ?? [];
        if (!chain.length) {
            throw new ExecutionPolicyError(`No provider chain defined in execution policy for capability: ${capability}`);
        }

        // Begin the turn once before provider iteration
        context.beginTurn(this.normalizeUserInput(capability, request));

        const errors: ProviderAttemptResult[] = [];
        const attempts: ProviderAttemptResult[] = [];

        // Metrics hook: execution start
        this.lifeCycleHooks?.onExecutionStart?.(capability, chain);

        // Attempt each provider in order
        for (let i = 0; i < chain.length; i++) {
            const { providerType, connectionName } = chain[i];
            const startTime = Date.now();

            const attemptCtx: ProviderAttemptContext = {
                capability,
                providerType,
                connectionName,
                attemptIndex: i,
                startTime
            };

            // Metrics hook: provider attempt start
            this.lifeCycleHooks?.onAttemptStart?.(attemptCtx);

            try {
                const provider = this.getProvider<BaseProvider>(providerType, connectionName);
                if (!provider.hasCapability(capability)) {
                    continue;
                }

                const signal = this.createExecutionSignal(request);

                const result: AIResponse<TRes> = await withRequestContext(request, () => executeFn(provider, context, signal));
                if (result.error) {
                    throw result.error;
                }

                if (result.output !== undefined) {
                    this.applyOutputToContext(capability, result.output, context);
                }

                // Metrics hook: provider attempt success
                const success: ProviderAttemptResult = {
                    ...attemptCtx,
                    durationMs: Date.now() - startTime,
                    ...this.extractAttemptUsage(result.metadata, result.rawResponse)
                };
                attempts.push(success);
                this.lifeCycleHooks?.onAttemptSuccess?.(success);
                this.lifeCycleHooks?.onExecutionEnd?.(capability, chain);

                return this.withProviderAttemptsMetadata(result, attempts);
            } catch (err) {
                const failure: ProviderAttemptResult = {
                    ...attemptCtx,
                    durationMs: Date.now() - startTime,
                    error: err instanceof Error ? err.message : String(err)
                };

                errors.push(failure);
                attempts.push(failure);
                // Metrics hook: provider attempt failed
                this.lifeCycleHooks?.onAttemptFailure?.(failure);
            }
        }

        this.lifeCycleHooks?.onExecutionFailure?.(capability, chain, errors);
        this.lifeCycleHooks?.onExecutionEnd?.(capability, chain);

        throw new AllProvidersFailedError(capability, chain, errors);
    }

    /**
     * Executes a streaming capability call across a provider chain with fallback support.
     *
     * Attempts each provider in order until one successfully yields chunks.
     * If a provider fails mid-stream, automatically falls back to the next provider.
     *
     * Note:
     * If a provider fails after yielding one or more chunks, the stream will
     * fall back to the next provider. Previously yielded chunks are not replayed.
     *
     * @template C Capability key (e.g., ChatStreamCapability, ImageGenerationStreamCapability)
     * @param capability The capability being invoked
     * @param request The request object created by the caller
     * @param context The multimodal execution context to attach this request to
     * @param executeFn Function that executes the call on a provider and returns an AsyncGenerator
     * @param providerChain Optional ordered list of providers to try; defaults to appConfig.executionPolicy.providerChain
     * @returns AsyncGenerator yielding chunks from the first successful provider
     * @throws AllProvidersFailedError if all providers fail immediately
     */
    private async *executeWithPolicyStream<C extends CapabilityKeyType, TReq, TRes>(
        capability: C,
        request: AIRequest<TReq>,
        context: MultiModalExecutionContext,
        executeFn: (
            provider: BaseProvider,
            ctx: MultiModalExecutionContext,
            signal?: AbortSignal
        ) => AsyncGenerator<AIResponseChunk<TRes>>,
        providerChain?: ProviderRef[]
    ): AsyncGenerator<AIResponseChunk<TRes>> {
        // Use chain from config if none explicitly provided
        const chain = providerChain ?? this.appConfig.appConfig?.executionPolicy?.providerChain ?? [];
        if (!chain.length) {
            throw new ExecutionPolicyError(`No provider chain defined for ${capability}`);
        }

        // Begin the turn once before provider iteration
        context.beginTurn(this.normalizeUserInput(capability, request));

        const errors: ProviderAttemptResult[] = [];
        const attempts: ProviderAttemptResult[] = [];
        this.lifeCycleHooks?.onExecutionStart?.(capability, chain);

        for (let i = 0; i < chain.length; i++) {
            const { providerType, connectionName } = chain[i];
            const startTime = Date.now();
            let chunkIndex = 0;
            let chunksEmitted = 0;
            let pendingChunk: AIResponseChunk<TRes> | undefined;

            const attemptCtx: ProviderAttemptContext = {
                capability,
                providerType,
                connectionName,
                attemptIndex: i,
                startTime
            };

            this.lifeCycleHooks?.onAttemptStart?.(attemptCtx);

            try {
                const provider = this.getProvider<BaseProvider>(providerType, connectionName);
                if (!provider.hasCapability(capability)) {
                    continue;
                }

                const signal = this.createExecutionSignal(request);

                let finalOutput: TRes | undefined;
                let latestChunkMetadata: AIResponseChunk<TRes>["metadata"] | undefined;
                for await (const chunk of withRequestContextStream(request, () => executeFn(provider, context, signal))) {
                    signal.throwIfAborted();

                    if (chunk.error) {
                        throw chunk.error;
                    }

                    // Attach any multimodal artifacts incrementally
                    if (chunk.multimodalArtifacts) {
                        context.yieldArtifacts(chunk.multimodalArtifacts);
                    }

                    // Track the final output if this chunk signals completion
                    if (chunk.output !== undefined) {
                        finalOutput = chunk.output;
                    }
                    if (chunk.metadata) {
                        latestChunkMetadata = chunk.metadata;
                    }

                    if (pendingChunk) {
                        yield pendingChunk;
                        this.lifeCycleHooks?.onChunkEmitted?.({
                            capability,
                            providerType,
                            connectionName,
                            chunkIndex,
                            chunkTimeMs: Date.now() - startTime
                        });
                        chunkIndex++;
                        chunksEmitted++;
                    }

                    pendingChunk = chunk;
                }

                if (finalOutput !== undefined) {
                    this.applyOutputToContext(capability, finalOutput, context);
                }

                const success: ProviderAttemptResult = {
                    ...attemptCtx,
                    durationMs: Date.now() - startTime,
                    chunksEmitted: chunksEmitted + (pendingChunk ? 1 : 0),
                    ...this.extractAttemptUsage(latestChunkMetadata ?? pendingChunk?.metadata, pendingChunk?.raw)
                };
                attempts.push(success);
                this.lifeCycleHooks?.onAttemptSuccess?.(success);

                if (pendingChunk) {
                    const chunkWithAttempts: AIResponseChunk<TRes> = {
                        ...pendingChunk,
                        metadata: {
                            ...(pendingChunk.metadata ?? {}),
                            providerAttempts: attempts.map((a) => this.sanitizeAttemptForMetadata(a))
                        }
                    };

                    yield chunkWithAttempts;
                    this.lifeCycleHooks?.onChunkEmitted?.({
                        capability,
                        providerType,
                        connectionName,
                        chunkIndex,
                        chunkTimeMs: Date.now() - startTime
                    });
                }

                this.lifeCycleHooks?.onExecutionEnd?.(capability, chain);
                return;
            } catch (err) {
                // Flush buffered chunk so successful partial output from this attempt isn't dropped.
                if (pendingChunk) {
                    yield pendingChunk;
                    this.lifeCycleHooks?.onChunkEmitted?.({
                        capability,
                        providerType,
                        connectionName,
                        chunkIndex,
                        chunkTimeMs: Date.now() - startTime
                    });
                    chunkIndex++;
                    chunksEmitted++;
                    pendingChunk = undefined;
                }

                const failure: ProviderAttemptResult = {
                    ...attemptCtx,
                    durationMs: Date.now() - startTime,
                    chunksEmitted,
                    error: err instanceof Error ? err.message : String(err)
                };

                errors.push(failure);
                attempts.push(failure);
                this.lifeCycleHooks?.onAttemptFailure?.(failure);
            }
        }

        this.lifeCycleHooks?.onExecutionFailure?.(capability, chain, errors);
        this.lifeCycleHooks?.onExecutionEnd?.(capability, chain);

        throw new AllProvidersFailedError(capability, chain, errors);
    }

    private withProviderAttemptsMetadata<TRes>(result: AIResponse<TRes>, attempts: ProviderAttemptResult[]): AIResponse<TRes> {
        return {
            ...result,
            metadata: {
                ...(result.metadata ?? {}),
                providerAttempts: attempts.map((a) => this.sanitizeAttemptForMetadata(a))
            }
        };
    }

    private sanitizeAttemptForMetadata(attempt: ProviderAttemptResult): Record<string, unknown> {
        return {
            capability: attempt.capability,
            providerType: attempt.providerType,
            attemptIndex: attempt.attemptIndex,
            durationMs: attempt.durationMs,
            chunksEmitted: attempt.chunksEmitted,
            inputTokens: attempt.inputTokens,
            outputTokens: attempt.outputTokens,
            totalTokens: attempt.totalTokens,
            estimatedCostUsd: attempt.estimatedCostUsd,
            ...(attempt.error ? { error: "Provider attempt failed" } : {})
        };
    }

    private extractAttemptUsage(
        metadata?: AIResponse<unknown>["metadata"] | AIResponseChunk<unknown>["metadata"],
        raw?: unknown
    ): Pick<ProviderAttemptResult, "inputTokens" | "outputTokens" | "totalTokens" | "estimatedCostUsd"> {
        const m = metadata ?? {};
        const usage = this.extractRawUsage(raw);

        const inputTokens =
            this.readNumber(m, "inputTokens") ??
            this.readNumber(usage, "input_tokens") ??
            this.readNumber(usage, "prompt_tokens") ??
            this.readNumber(usage, "promptTokenCount");
        const outputTokens =
            this.readNumber(m, "outputTokens") ??
            this.readNumber(usage, "output_tokens") ??
            this.readNumber(usage, "completion_tokens") ??
            this.readNumber(usage, "candidatesTokenCount");
        const totalTokens =
            this.readNumber(m, "totalTokens") ??
            this.readNumber(m, "tokensUsed") ??
            this.readNumber(usage, "total_tokens") ??
            this.readNumber(usage, "totalTokenCount");
        const estimatedCostUsd = this.readNumber(m, "estimatedCostUsd") ?? this.readNumber(m, "costUsd");

        return {
            inputTokens,
            outputTokens,
            totalTokens,
            estimatedCostUsd
        };
    }

    private readNumber(source: Record<string, unknown>, key: string): number | undefined {
        const value = source[key];
        return typeof value === "number" && Number.isFinite(value) ? value : undefined;
    }

    private extractRawUsage(raw: unknown): Record<string, unknown> {
        if (!raw || typeof raw !== "object") {
            return {};
        }

        const direct = raw as Record<string, unknown>;
        const usage = direct["usage"];
        if (usage && typeof usage === "object") {
            return usage as Record<string, unknown>;
        }

        const usageMetadata = direct["usageMetadata"];
        if (usageMetadata && typeof usageMetadata === "object") {
            return usageMetadata as Record<string, unknown>;
        }

        return {};
    }

    private normalizeUserInput<T>(capability: CapabilityKeyType, request: AIRequest<T>): NormalizedUserInput {
        return {
            id: crypto.randomUUID(),
            modality: this.modalityForCapability(capability),
            input: request.input,
            metadata: {
                requestId: request.context?.requestId
            }
        };
    }

    private modalityForCapability(capability: CapabilityKeyType): NormalizedUserInput["modality"] {
        switch (capability) {
            case CapabilityKeys.ChatCapabilityKey:
            case CapabilityKeys.ChatStreamCapabilityKey:
                return "chat";
            case CapabilityKeys.EmbedCapabilityKey:
                return "embedding";
            case CapabilityKeys.ModerationCapabilityKey:
                return "moderation";
            case CapabilityKeys.ImageGenerationCapabilityKey:
            case CapabilityKeys.ImageGenerationStreamCapabilityKey:
                return "imageGeneration";
            case CapabilityKeys.ImageEditCapabilityKey:
            case CapabilityKeys.ImageEditStreamCapabilityKey:
                return "imageEdit";
            case CapabilityKeys.ImageAnalysisCapabilityKey:
            case CapabilityKeys.ImageAnalysisStreamCapabilityKey:
                return "imageAnalysis";
            default:
                return "custom";
        }
    }

    private applyOutputToContext(capability: CapabilityKeyType, output: unknown, context: MultiModalExecutionContext) {
        switch (capability) {
            case CapabilityKeys.ChatCapabilityKey:
            case CapabilityKeys.ChatStreamCapabilityKey:
                context.applyAssistantMessage(this.expectObject<NormalizedChatMessage>(capability, output, "chat output"));
                break;

            case CapabilityKeys.EmbedCapabilityKey:
                context.attachArtifacts({
                    embeddings: this.expectArray<NormalizedEmbedding>(capability, output, "embeddings output")
                });
                break;

            case CapabilityKeys.ModerationCapabilityKey:
                context.attachArtifacts({
                    moderation: this.expectArray<NormalizedModeration>(capability, output, "moderation output")
                });
                break;

            case CapabilityKeys.ImageGenerationCapabilityKey:
            case CapabilityKeys.ImageGenerationStreamCapabilityKey:
            case CapabilityKeys.ImageEditCapabilityKey:
                context.attachArtifacts({
                    images: this.expectArray<NormalizedImage>(capability, output, "images output")
                });
                break;

            case CapabilityKeys.ImageAnalysisCapabilityKey:
            case CapabilityKeys.ImageAnalysisStreamCapabilityKey:
                context.attachArtifacts({
                    analysis: this.expectArray<NormalizedImageAnalysis>(capability, output, "analysis output")
                });
                break;
            case CapabilityKeys.ImageEditStreamCapabilityKey:
                // no-op, artifacts already attached
                break;

            default:
                // For custom capabilities, we don't know how to interpret the output,
                // so we just return and leave it to the caller to handle it as needed.
                return;
        }
    }

    private createExecutionSignal(request: AIRequest<any>): AbortSignal {
        // If caller already provided a signal *and* no timeout, reuse it directly
        if (request.signal && !request.timeoutMs) {
            return request.signal;
        }

        const controller = new AbortController();

        // Forward caller cancellation
        if (request.signal) {
            if (request.signal.aborted) {
                controller.abort(request.signal.reason);
            } else {
                const forwardAbort = () => {
                    controller.abort(request.signal?.reason);
                };
                request.signal.addEventListener("abort", forwardAbort, { once: true });
                controller.signal.addEventListener(
                    "abort",
                    () => {
                        request.signal?.removeEventListener("abort", forwardAbort);
                    },
                    { once: true }
                );
            }
        }

        // Enforce timeout
        if (request.timeoutMs != null) {
            const timeoutId = setTimeout(() => {
                controller.abort(new Error("Execution timed out"));
            }, request.timeoutMs);

            // Cleanup timer if aborted early
            controller.signal.addEventListener("abort", () => {
                clearTimeout(timeoutId);
            });
        }

        return controller.signal;
    }

    private mergeTimelineArtifacts(target: TimelineArtifacts, next: TimelineArtifacts) {
        for (const key of Object.keys(next) as (keyof TimelineArtifacts)[]) {
            const incoming = next[key];
            if (!incoming || incoming.length === 0) {
                continue;
            }

            if (!target[key]) {
                target[key] = [];
            }

            (target[key] as unknown[]).push(...incoming);
        }
    }

    private buildArtifactsFromOutput(capability: CapabilityKeyType, output: unknown): TimelineArtifacts | undefined {
        switch (capability) {
            case CapabilityKeys.ChatCapabilityKey:
            case CapabilityKeys.ChatStreamCapabilityKey:
                return { chat: [this.expectObject<NormalizedChatMessage>(capability, output, "chat output")] };
            case CapabilityKeys.EmbedCapabilityKey:
                return { embeddings: this.expectArray<NormalizedEmbedding>(capability, output, "embeddings output") };
            case CapabilityKeys.ModerationCapabilityKey:
                return { moderation: this.expectArray<NormalizedModeration>(capability, output, "moderation output") };
            case CapabilityKeys.ImageGenerationCapabilityKey:
            case CapabilityKeys.ImageGenerationStreamCapabilityKey:
            case CapabilityKeys.ImageEditCapabilityKey:
                return { images: this.expectArray<NormalizedImage>(capability, output, "images output") };
            case CapabilityKeys.ImageAnalysisCapabilityKey:
            case CapabilityKeys.ImageAnalysisStreamCapabilityKey:
                return { analysis: this.expectArray<NormalizedImageAnalysis>(capability, output, "analysis output") };
            case CapabilityKeys.ImageEditStreamCapabilityKey:
                return undefined;
            default:
                return undefined;
        }
    }

    private expectArray<T>(capability: CapabilityKeyType, value: unknown, label: string): T[] {
        if (!Array.isArray(value)) {
            throw new Error(`AIClient: invalid ${label} for capability '${capability}' (expected array)`);
        }
        return value as T[];
    }

    private expectObject<T extends object>(capability: CapabilityKeyType, value: unknown, label: string): T {
        if (!value || typeof value !== "object" || Array.isArray(value)) {
            throw new Error(`AIClient: invalid ${label} for capability '${capability}' (expected object)`);
        }
        return value as T;
    }
}
