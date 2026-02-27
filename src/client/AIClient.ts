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
    createDefaultExecutors,
    CapabilityExecutorRegistry,
    CapabilityExecutor,
    NonStreamingExecutor,
    StreamingExecutor,
    AIClientLifecycleHooks,
    JobLifecycleHooks,
    readNumber,
    expectObjectForCapability,
    expectArrayForCapability
} from "#root/index.js";

/**
 * Main orchestrator for ProviderPlaneAI consumers.
 *
 * ## Responsibilities
 * - Load and manage application configuration
 * - Register, initialize, and route to AI providers
 * - Enforce capability availability and fail-fast error handling
 * - Manage session lifecycle and event timelines
 * - Provide job-first, provider-agnostic orchestration for all capabilities
 *
 * ## Design
 * - No provider-specific logic or AI implementation details
 * - Providers are opaque containers of capabilities
 * - Focuses on orchestration, error handling, and capability-based routing
 *
 * ## Usage
 * Instantiate once, register providers, and use for all AI requests and session management.
 *
 * @remarks
 * This class is the central hub for all AI operations, ensuring that consumers interact with a unified interface regardless of provider or capability.
 */
export class AIClient {
    /**
     * Provider registry:
     *   Provider type (e.g. OpenAI, Anthropic)
     *     -> connection name (e.g. "default", "prod", "staging")
     *       -> provider instance
     *
     * Allows multiple credentials or environments per provider.
     *
     * @private
     */
    private providers: Map<AIProviderType, Map<string, BaseProvider>> = new Map();

    /**
     * Registry of capability executors.
     * Maps capability keys to their executor implementations.
     * @private
     */
    private executors: CapabilityExecutorRegistry;

    /**
     * Application configuration loaded from config files and environment variables.
     * Resolved once at construction and passed to providers during initialization.
     *
     * AIClient does not interpret provider-specific config, but wires core app-level
     * options (concurrency, queue, chunk retention, raw retention, etc.) through to JobManager.
     *
     * @private
     */
    private appConfig: AppConfig;

    /**
     * Optional lifecycle hooks for metrics, observability, and instrumentation.
     * Can be set only once per client instance.
     * @private
     */
    private lifecycleHooks?: AIClientLifecycleHooks;

    /**
     * Job manager instance for managing job execution and lifecycle.
     * @private
     */
    private _jobManager: JobManager;

    /**
     * Constructs a new AIClient instance.
     *
     * @param jobManager Optional custom JobManager instance.
     * @param executors Optional custom CapabilityExecutorRegistry.
     */
    constructor(jobManager?: JobManager, executors?: CapabilityExecutorRegistry) {
        // Load application configuration from files and environment variables
        const appConfig = loadAppConfig();
        this.appConfig = appConfig;
        // Extract core app-level options for job manager wiring
        const configuredMaxConcurrency = appConfig.appConfig?.maxConcurrency;
        const configuredMaxQueueSize = appConfig.appConfig?.maxQueueSize;
        const configuredMaxStoredResponseChunks = appConfig.appConfig?.maxStoredResponseChunks;
        const configuredStoreRawResponses = appConfig.appConfig?.storeRawResponses;
        const configuredMaxRawBytesPerJob = appConfig.appConfig?.maxRawBytesPerJob;

        if (jobManager) {
            // If a custom JobManager is provided, ensure its config is set or fallback to appConfig
            if (jobManager.getMaxConcurrency() === undefined) {
                // Set max concurrency from config if not already set
                jobManager.setMaxConcurrency(configuredMaxConcurrency);
            }
            if (jobManager.getMaxQueueSize() === undefined) {
                // Set max queue size from config if not already set
                jobManager.setMaxQueueSize(configuredMaxQueueSize);
            }
            if (jobManager.getMaxStoredResponseChunks() === undefined) {
                // Set max stored response chunks from config if not already set
                jobManager.setMaxStoredResponseChunks(configuredMaxStoredResponseChunks);
            }
            if (jobManager.getStoreRawResponses() === undefined) {
                // Set storeRawResponses from config if not already set
                jobManager.setStoreRawResponses(configuredStoreRawResponses);
            }
            if (jobManager.getMaxRawBytesPerJob() === undefined) {
                // Set max raw bytes per job from config if not already set
                jobManager.setMaxRawBytesPerJob(configuredMaxRawBytesPerJob);
            }
            this._jobManager = jobManager;
        } else {
            // Otherwise, create a new JobManager using config values
            this._jobManager = new JobManager({
                maxConcurrency: configuredMaxConcurrency,
                maxQueueSize: configuredMaxQueueSize,
                maxStoredResponseChunks: configuredMaxStoredResponseChunks,
                storeRawResponses: configuredStoreRawResponses,
                maxRawBytesPerJob: configuredMaxRawBytesPerJob
            });
        }

        // Register capability executors first so auto-registered providers receive the full executor map.
        // Manual registration is still supported and can override this.
        this.executors = executors ?? createDefaultExecutors();

        // Auto-register providers declared in appConfig.executionPolicy.providerChain.
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
    }

    /**
     * Set lifecycle hooks for metrics, observability, and instrumentation.
     * Can only be set once per client instance.
     *
     * @param lifecycleHooks The hooks to set on client lifecycle events.
     * @throws Error if hooks are already set.
     */
    setLifecycleHooks(lifecycleHooks: AIClientLifecycleHooks) {
        // Only allow hooks to be set once per client instance
        if (this.lifecycleHooks) {
            throw new Error("Lifecycle hooks already set");
        }
        this.lifecycleHooks = lifecycleHooks;
    }

    /**
     * Registers and initializes a provider instance.
     *
     * Invariants:
     * - A provider + connectionName pair may only be registered once.
     * - Providers are initialized lazily at registration time with config from appConfig.
     * - Capability registration is the provider’s responsibility, not the client’s.
     * - Executors are set on the provider after registration.
     *
     * @param provider The provider instance to register.
     * @param providerType The type of the provider (e.g. OpenAI, Anthropic).
     * @param connectionName Optional connection name; defaults to "default".
     * @throws DuplicateProviderRegistrationError if the provider + connectionName is already registered.
     * @throws ExecutionPolicyError if the provider configuration is missing.
     */
    public registerProvider(provider: BaseProvider, providerType: AIProviderType, connectionName: string = "default") {
        const providerMap = this.providers.get(providerType) || new Map();

        if (providerMap?.has(connectionName)) {
            // Prevent accidental double registration
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

    /**
     * Registers a non-streaming capability executor for a built-in capability.
     *
     * @param capability The built-in capability key.
     * @param executor The non-streaming executor instance.
     */
    public registerCapabilityExecutor<C extends BuiltInCapabilityKey, TInput, TOutput>(
        capability: C,
        executor: NonStreamingExecutor<C, TInput, TOutput>
    ): void;

    /**
     * Registers a streaming capability executor for a built-in capability.
     *
     * @param capability The built-in capability key.
     * @param executor The streaming executor instance.
     */
    public registerCapabilityExecutor<C extends BuiltInCapabilityKey, TInput, TOutput>(
        capability: C,
        executor: StreamingExecutor<C, TInput, TOutput>
    ): void;

    /**
     * Registers a custom capability executor (streaming or non-streaming).
     *
     * @param capability The custom capability key.
     * @param executor The executor instance.
     */
    public registerCapabilityExecutor<TInput, TOutput>(
        capability: CustomCapabilityKey,
        executor: StreamingExecutor<any, TInput, TOutput> | NonStreamingExecutor<any, TInput, TOutput>
    ): void;

    /**
     * Registers a capability executor for a given capability key.
     * Throws if an executor is already registered for the capability.
     * Automatically updates all registered providers with the new executors map.
     *
     * @template C Capability key type
     * @template TInput Input type for the executor
     * @template TOutput Output type for the executor
     * @param capability The capability key.
     * @param executor The executor instance.
     * @throws Error if an executor is already registered for the capability.
     */
    public registerCapabilityExecutor<C extends CapabilityKeyType, TInput, TOutput>(
        capability: C,
        executor: StreamingExecutor<C, TInput, TOutput> | NonStreamingExecutor<C, TInput, TOutput>
    ) {
        if (this.executors.has(capability)) {
            throw new Error(`Executor for capability ${capability} is already registered`);
        }
        this.executors.set(capability, executor);

        // Propagate executor updates to all registered providers so new capabilities are immediately available.
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
     * @param type Provider type to resolve.
     * @param connectionName Optional connection name; defaults to "default".
     * @returns The requested provider instance.
     * @throws Error if the provider type or connection name is not registered.
     */
    public getProvider<T extends BaseProvider>(type: AIProviderType, connectionName: string = "default"): T {
        // Look up the provider map for the given type
        const connections = this.providers.get(type);
        if (!connections) {
            throw new Error(`No providers registered for ${type}`);
        }

        const provider = connections.get(connectionName);
        // Look up the provider instance for the given connection name
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
     * @param capability The capability key to search for.
     * @returns Array of providers that implement the requested capability.
     */
    public findProvidersByCapability<C extends CapabilityKeyType>(capability: C): BaseProvider[] {
        // Collect all providers that implement the requested capability
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
     * Most consumers should create jobs via {@link createCapabilityJob} and execute via this manager.
     * @returns The JobManager instance.
     */
    public get jobManager() {
        // Return the JobManager instance for advanced job management
        return this._jobManager;
    }

    /**
     * Creates a new job for executing a capability with full lifecycle management.
     *
     * This is the primary entry point for consumers to submit AI requests.
     * The returned job can be queued, observed, persisted, rerun, and supports streaming or non-streaming execution.
     *
     * Features:
     * - Supports custom per-job overrides for chunk retention, raw payload retention, and byte budget.
     * - Allows specifying a custom provider chain for fallback/routing.
     * - Optionally attaches custom lifecycle hooks for job-level observability.
     * - By default, adds the job to the JobManager for execution and tracking.
     *
     * @template C Capability key type (e.g., chat, image, embedding)
     * @template TInput Input type for the capability
     * @template TOutput Output type for the capability
     * @param capability The capability key to execute (must be registered).
     * @param request The AIRequest payload (input, options, context, etc.).
     * @param options Optional per-job overrides:
     *   - maxStoredResponseChunks: Max number of response chunks to retain
     *   - storeRawResponses: Whether to retain raw provider payloads
     *   - maxRawBytesPerJob: Max bytes of raw payloads to retain
     *   - providerChain: Custom provider fallback chain for this job
     *   - addToManager: If false, does not add job to JobManager (manual control)
     *   - lifecycleHooks: Custom hooks for this job's lifecycle events
     * @returns A GenericJob instance representing the full execution lifecycle.
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
        // Look up executor for capability
        // Determine streaming mode for job
        // Resolve chunk/raw retention options (job > manager > config)
        // Create job instance with resolved options and execution logic
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
                    // Streaming mode: merge chunks, update artifacts, and handle output
                    let finalOutput: TOutput | undefined;
                    let finalInternalChunk: AIResponseChunk<TOutput> | undefined;
                    let latestChunkId: string | undefined;
                    let latestChunkRaw: unknown;
                    let mergedMetadata: AIResponse<TOutput>["metadata"] | undefined;
                    const mergedArtifacts: TimelineArtifacts = {};

                    // Iterate over streamed chunks from provider chain
                    for await (const chunk of this.executeWithPolicyStream<C, TInput, TOutput>(
                        capability,
                        input,
                        ctx,
                        (provider, cctx, sig) => executor.invoke(provider.getCapability(capability), input, cctx, sig),
                        options?.providerChain
                    )) {
                        signal?.throwIfAborted();
                        // Track latest chunk id and raw payload
                        if (chunk.id) {
                            latestChunkId = chunk.id;
                        }
                        if (chunk.raw !== undefined) {
                            // Track latest chunk raw payload
                            latestChunkRaw = chunk.raw;
                        }
                        // Merge chunk metadata for diagnostics
                        if (chunk.metadata) {
                            mergedMetadata = mergedMetadata ?? {};
                            Object.assign(mergedMetadata, chunk.metadata);
                        }
                        // Merge multimodal artifacts for timeline/context
                        if (chunk.multimodalArtifacts) {
                            this.mergeTimelineArtifacts(mergedArtifacts, chunk.multimodalArtifacts);
                        }

                        // Emit chunk delta to consumer if present
                        if (chunk.delta !== undefined && onChunk) {
                            onChunk({ delta: chunk.delta }, chunk);
                        }

                        // Track final output and chunk for completion
                        if (chunk.output !== undefined) {
                            finalOutput = chunk.output;
                            finalInternalChunk = chunk;
                        }
                    }

                    // Emit final output to consumer
                    if (finalOutput !== undefined && onChunk) {
                        onChunk({ final: finalOutput }, finalInternalChunk ?? { output: finalOutput, done: true });
                    }
                    // Error if stream completes without output
                    if (finalOutput === undefined) {
                        throw new Error(`AIClient: capability '${capability}' stream completed without final output`);
                    }
                    // Fallback to build artifacts if none were merged
                    const fallbackArtifacts = this.buildArtifactsFromOutput(capability, finalOutput);
                    return {
                        // Return merged output, artifacts, and metadata
                        // Non-streaming mode: invoke executor and handle output
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
                    // Non-streaming mode: invoke executor and handle output
                    const result = await this.executeWithPolicy<C, TInput, TOutput>(
                        capability,
                        input,
                        ctx,
                        (provider, cctx, sig) => executor.invoke(provider.getCapability(capability), input, cctx, sig),
                        options?.providerChain
                    );

                    // Return result if artifacts present or output is undefined
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
            // Optionally add job to manager for execution/tracking
            this._jobManager.addJob(job);
        }

        return job;
    }

    /**
     * Executes a capability call across a provider chain with fallback support.
     *
     * Attempts each provider in order until one succeeds, or throws if all fail.
     *
     * @template C Capability key (e.g., ChatCapability, ImageAnalysisCapability)
     * @template TReq Input type for the capability
     * @template TRes Output type for the capability
     * @param capability The capability being invoked.
     * @param request The request object created by the caller.
     * @param context The multimodal execution context to attach this request to.
     * @param executeFn Function that executes the call on a provider.
     * @param providerChain Optional ordered list of providers to try; defaults to appConfig.executionPolicy.providerChain.
     * @returns Result of the first successful provider call.
     * @throws AllProvidersFailedError if all providers fail.
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
        this.lifecycleHooks?.onExecutionStart?.(capability, chain);

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
            this.lifecycleHooks?.onAttemptStart?.(attemptCtx);

            try {
                const provider = this.getProvider<BaseProvider>(providerType, connectionName);
                // Resolve provider instance for this attempt
                if (!provider.hasCapability(capability)) {
                    // Skip provider if it does not implement the capability
                    continue;
                }

                const signal = this.createExecutionSignal(request);

                const result: AIResponse<TRes> = await withRequestContext(request, () => executeFn(provider, context, signal));
                if (result.error) {
                    // Throw if provider returns error
                    throw result.error;
                }

                if (result.output !== undefined) {
                    // Apply output to context for timeline/artifact tracking
                    this.applyOutputToContext(capability, result.output, context);
                }

                // Metrics hook: provider attempt success
                const success: ProviderAttemptResult = {
                    ...attemptCtx,
                    durationMs: Date.now() - startTime,
                    ...this.extractAttemptUsage(result.metadata, result.rawResponse)
                };
                attempts.push(success);
                this.lifecycleHooks?.onAttemptSuccess?.(success);
                this.lifecycleHooks?.onExecutionEnd?.(capability, chain);

                return this.withProviderAttemptsMetadata(result, attempts);
            } catch (err) {
                // Handle provider failure, record error and fire hooks
                const failure: ProviderAttemptResult = {
                    ...attemptCtx,
                    durationMs: Date.now() - startTime,
                    error: err instanceof Error ? err.message : String(err)
                };

                errors.push(failure);
                attempts.push(failure);
                // Metrics hook: provider attempt failed
                this.lifecycleHooks?.onAttemptFailure?.(failure);
            }
        }

        this.lifecycleHooks?.onExecutionFailure?.(capability, chain, errors);
        this.lifecycleHooks?.onExecutionEnd?.(capability, chain);

        throw new AllProvidersFailedError(capability, chain, errors);
        // Throw if all providers fail
    }

    /**
     * Executes a streaming capability call across a provider chain with fallback support.
     *
     * This method attempts each provider in the chain in order, yielding streamed chunks as soon as they are available.
     * If a provider fails mid-stream, it automatically falls back to the next provider in the chain.
     * Previously yielded chunks are not replayed; only new chunks from the fallback provider are yielded.
     *
     * Metrics and lifecycle hooks are triggered for each attempt, chunk emission, and overall execution.
     *
     * @template C Capability key (e.g., ChatStreamCapability, ImageGenerationStreamCapability)
     * @template TReq Input type for the capability
     * @template TRes Output type for the capability
     * @param capability The capability being invoked.
     * @param request The request object created by the caller.
     * @param context The multimodal execution context to attach this request to.
     * @param executeFn Function that executes the call on a provider and returns an AsyncGenerator.
     * @param providerChain Optional ordered list of providers to try; defaults to appConfig.executionPolicy.providerChain.
     * @returns AsyncGenerator yielding chunks from the first successful provider.
     * @throws AllProvidersFailedError if all providers fail immediately.
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
        // Use provider chain from config if none explicitly provided
        const chain = providerChain ?? this.appConfig.appConfig?.executionPolicy?.providerChain ?? [];
        if (!chain.length) {
            // Fail-fast if no provider chain is defined
            throw new ExecutionPolicyError(`No provider chain defined for ${capability}`);
        }

        // Begin the turn once before provider iteration for timeline/context
        context.beginTurn(this.normalizeUserInput(capability, request));

        // Track errors and attempts for diagnostics and reporting
        const errors: ProviderAttemptResult[] = [];
        const attempts: ProviderAttemptResult[] = [];
        // Metrics hook: execution start
        this.lifecycleHooks?.onExecutionStart?.(capability, chain);

        // Attempt each provider in order, yielding chunks until one succeeds or all fail
        for (let i = 0; i < chain.length; i++) {
            const { providerType, connectionName } = chain[i];
            const startTime = Date.now();
            let chunkIndex = 0;
            let chunksEmitted = 0;
            let pendingChunk: AIResponseChunk<TRes> | undefined;

            // Build attempt context for metrics and hooks
            const attemptCtx: ProviderAttemptContext = {
                capability,
                providerType,
                connectionName,
                attemptIndex: i,
                startTime
            };

            // Metrics hook: provider attempt start
            this.lifecycleHooks?.onAttemptStart?.(attemptCtx);

            try {
                // Resolve provider instance for this attempt
                const provider = this.getProvider<BaseProvider>(providerType, connectionName);
                // Skip provider if it does not implement the capability
                if (!provider.hasCapability(capability)) {
                    continue;
                }

                // Create abort signal for timeout/cancellation
                const signal = this.createExecutionSignal(request);

                let finalOutput: TRes | undefined;
                let latestChunkMetadata: AIResponseChunk<TRes>["metadata"] | undefined;
                // Stream chunks from the provider, yielding as they arrive
                for await (const chunk of withRequestContextStream(request, () => executeFn(provider, context, signal))) {
                    signal.throwIfAborted();

                    // Throw if chunk signals error
                    if (chunk.error) {
                        throw chunk.error;
                    }

                    // Attach any multimodal artifacts incrementally to context
                    if (chunk.multimodalArtifacts) {
                        context.yieldArtifacts(chunk.multimodalArtifacts);
                    }

                    // Track the final output if this chunk signals completion
                    if (chunk.output !== undefined) {
                        finalOutput = chunk.output;
                    }
                    // Track latest chunk metadata for usage/cost reporting
                    if (chunk.metadata) {
                        latestChunkMetadata = chunk.metadata;
                    }

                    // If a previous chunk is buffered, yield it now (buffering allows metadata augmentation)
                    if (pendingChunk) {
                        yield pendingChunk;
                        this.lifecycleHooks?.onChunkEmitted?.({
                            capability,
                            providerType,
                            connectionName,
                            chunkIndex,
                            chunkTimeMs: Date.now() - startTime
                        });
                        chunkIndex++;
                        chunksEmitted++;
                    }

                    // Buffer the current chunk for possible augmentation
                    pendingChunk = chunk;
                }

                // Apply output to context for timeline/artifact tracking
                if (finalOutput !== undefined) {
                    this.applyOutputToContext(capability, finalOutput, context);
                }

                // Build success attempt result for metrics and reporting
                const success: ProviderAttemptResult = {
                    ...attemptCtx,
                    durationMs: Date.now() - startTime,
                    chunksEmitted: chunksEmitted + (pendingChunk ? 1 : 0),
                    ...this.extractAttemptUsage(latestChunkMetadata ?? pendingChunk?.metadata, pendingChunk?.raw)
                };
                attempts.push(success);
                this.lifecycleHooks?.onAttemptSuccess?.(success);

                // Yield the final buffered chunk, attaching provider attempt metadata
                if (pendingChunk) {
                    const chunkWithAttempts: AIResponseChunk<TRes> = {
                        ...pendingChunk,
                        metadata: {
                            ...(pendingChunk.metadata ?? {}),
                            providerAttempts: attempts.map((a) => this.sanitizeAttemptForMetadata(a))
                        }
                    };

                    yield chunkWithAttempts;
                    this.lifecycleHooks?.onChunkEmitted?.({
                        capability,
                        providerType,
                        connectionName,
                        chunkIndex,
                        chunkTimeMs: Date.now() - startTime
                    });
                }

                // Metrics hook: execution end
                this.lifecycleHooks?.onExecutionEnd?.(capability, chain);
                return;
            } catch (err) {
                // Flush buffered chunk before fallback so partial successful output is preserved.
                // We buffer one chunk to allow final-chunk metadata augmentation on success paths.
                if (pendingChunk) {
                    yield pendingChunk;
                    this.lifecycleHooks?.onChunkEmitted?.({
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

                // Build failure attempt result for metrics and reporting
                const failure: ProviderAttemptResult = {
                    ...attemptCtx,
                    durationMs: Date.now() - startTime,
                    chunksEmitted,
                    error: err instanceof Error ? err.message : String(err)
                };

                errors.push(failure);
                attempts.push(failure);
                this.lifecycleHooks?.onAttemptFailure?.(failure);
            }
        }

        // All providers failed; fire hooks and throw error
        this.lifecycleHooks?.onExecutionFailure?.(capability, chain, errors);
        this.lifecycleHooks?.onExecutionEnd?.(capability, chain);

        throw new AllProvidersFailedError(capability, chain, errors);
    }

    /**
     * Attaches provider attempt metadata to an AIResponse.
     *
     * @param result The AIResponse to augment.
     * @param attempts The list of provider attempt results.
     * @returns The AIResponse with providerAttempts metadata included.
     */
    private withProviderAttemptsMetadata<TRes>(result: AIResponse<TRes>, attempts: ProviderAttemptResult[]): AIResponse<TRes> {
        return {
            ...result,
            metadata: {
                ...(result.metadata ?? {}),
                providerAttempts: attempts.map((a) => this.sanitizeAttemptForMetadata(a))
            }
        };
    }

    /**
     * Sanitizes a provider attempt result for inclusion in response metadata.
     *
     * @param attempt The provider attempt result.
     * @returns A sanitized metadata object.
     */
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
            estimatedCost: attempt.estimatedCost,
            ...(attempt.error ? { error: "Provider attempt failed" } : {})
        };
    }

    /**
     * Extracts usage statistics from response metadata or raw payload.
     *
     * @param metadata The response or chunk metadata.
     * @param raw The raw provider payload.
     * @returns An object with inputTokens, outputTokens, totalTokens, and estimatedCost.
     */
    private extractAttemptUsage(
        metadata?: AIResponse<unknown>["metadata"] | AIResponseChunk<unknown>["metadata"],
        raw?: unknown
    ): Pick<ProviderAttemptResult, "inputTokens" | "outputTokens" | "totalTokens" | "estimatedCost"> {
        const m = metadata ?? {};
        const usage = this.extractRawUsage(raw);

        const inputTokens =
            readNumber(m, "inputTokens") ??
            readNumber(usage, "input_tokens") ??
            readNumber(usage, "prompt_tokens") ??
            readNumber(usage, "promptTokenCount");
        const outputTokens =
            readNumber(m, "outputTokens") ??
            readNumber(usage, "output_tokens") ??
            readNumber(usage, "completion_tokens") ??
            readNumber(usage, "candidatesTokenCount");
        const totalTokens =
            readNumber(m, "totalTokens") ??
            readNumber(m, "tokensUsed") ??
            readNumber(usage, "total_tokens") ??
            readNumber(usage, "totalTokenCount");
        const estimatedCost = readNumber(m, "estimatedCost") ?? readNumber(m, "cost");

        return {
            inputTokens,
            outputTokens,
            totalTokens,
            estimatedCost
        };
    }

    /**
     * Extracts a usage object from a raw provider payload.
     * @param raw The raw provider payload.
     * @returns The usage object if found, otherwise an empty object.
     */
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

    /**
     * Normalizes user input for context tracking and timeline management.
     * @param capability The capability key.
     * @param request The AIRequest object.
     * @returns A NormalizedUserInput object.
     */
    private normalizeUserInput<T>(capability: CapabilityKeyType, request: AIRequest<T>): NormalizedUserInput {
        // Normalize user input for context/timeline tracking
        return {
            id: crypto.randomUUID(),
            modality: this.modalityForCapability(capability),
            input: request.input,
            metadata: {
                requestId: request.context?.requestId
            }
        };
    }

    /**
     * Infers the modality for a given capability key.
     * @param capability The capability key.
     * @returns The inferred modality string.
     */
    private modalityForCapability(capability: CapabilityKeyType): NormalizedUserInput["modality"] {
        // Map capability keys to modality strings for analytics/context
        switch (capability) {
            case CapabilityKeys.ChatCapabilityKey:
            case CapabilityKeys.ChatStreamCapabilityKey:
                // Chat-related capabilities
                return "chat";
            case CapabilityKeys.EmbedCapabilityKey:
                // Embedding capability
                return "embedding";
            case CapabilityKeys.ModerationCapabilityKey:
                // Moderation capability
                return "moderation";
            case CapabilityKeys.ImageGenerationCapabilityKey:
            case CapabilityKeys.ImageGenerationStreamCapabilityKey:
                // Image generation capabilities
                return "imageGeneration";
            case CapabilityKeys.ImageEditCapabilityKey:
            case CapabilityKeys.ImageEditStreamCapabilityKey:
                // Image edit capabilities
                return "imageEdit";
            case CapabilityKeys.ImageAnalysisCapabilityKey:
            case CapabilityKeys.ImageAnalysisStreamCapabilityKey:
                // Image analysis capabilities
                return "imageAnalysis";
            default:
                // Custom or unknown capability
                return "custom";
        }
    }

    /**
     * Applies output to the execution context for timeline and artifact tracking.
     * @param capability The capability key.
     * @param output The output to apply.
     * @param context The execution context.
     */
    private applyOutputToContext(capability: CapabilityKeyType, output: unknown, context: MultiModalExecutionContext) {
        switch (capability) {
            case CapabilityKeys.ChatCapabilityKey:
            case CapabilityKeys.ChatStreamCapabilityKey:
                context.applyAssistantMessage(expectObjectForCapability<NormalizedChatMessage>(capability, output, "chat output"));
                break;

            case CapabilityKeys.EmbedCapabilityKey:
                context.attachArtifacts({
                    embeddings: expectArrayForCapability<NormalizedEmbedding>(capability, output, "embeddings output")
                });
                break;

            case CapabilityKeys.ModerationCapabilityKey:
                context.attachArtifacts({
                    moderation: expectArrayForCapability<NormalizedModeration>(capability, output, "moderation output")
                });
                break;

            case CapabilityKeys.ImageGenerationCapabilityKey:
            case CapabilityKeys.ImageGenerationStreamCapabilityKey:
            case CapabilityKeys.ImageEditCapabilityKey:
                context.attachArtifacts({
                    images: expectArrayForCapability<NormalizedImage>(capability, output, "images output")
                });
                break;

            case CapabilityKeys.ImageAnalysisCapabilityKey:
            case CapabilityKeys.ImageAnalysisStreamCapabilityKey:
                context.attachArtifacts({
                    analysis: expectArrayForCapability<NormalizedImageAnalysis>(capability, output, "analysis output")
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

    /**
     * Creates an AbortSignal for a request, handling timeouts and cancellation.
     * @param request The AIRequest object.
     * @returns An AbortSignal for the request.
     */
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

    /**
     * Merges timeline artifacts from one object into another.
     *
     * @param target The target TimelineArtifacts object.
     * @param next The next TimelineArtifacts object to merge in.
     */
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

    /**
     * Builds timeline artifacts from a capability output.
     * @param capability The capability key.
     * @param output The output to extract artifacts from.
     * @returns TimelineArtifacts if available, otherwise undefined.
     */
    private buildArtifactsFromOutput(capability: CapabilityKeyType, output: unknown): TimelineArtifacts | undefined {
        // Build artifacts for built-in capabilities; custom capabilities return undefined
        switch (capability) {
            case CapabilityKeys.ChatCapabilityKey:
            case CapabilityKeys.ChatStreamCapabilityKey:
                return { chat: [expectObjectForCapability<NormalizedChatMessage>(capability, output, "chat output")] };
            case CapabilityKeys.EmbedCapabilityKey:
                return { embeddings: expectArrayForCapability<NormalizedEmbedding>(capability, output, "embeddings output") };
            case CapabilityKeys.ModerationCapabilityKey:
                return { moderation: expectArrayForCapability<NormalizedModeration>(capability, output, "moderation output") };
            case CapabilityKeys.ImageGenerationCapabilityKey:
            case CapabilityKeys.ImageGenerationStreamCapabilityKey:
            case CapabilityKeys.ImageEditCapabilityKey:
                return { images: expectArrayForCapability<NormalizedImage>(capability, output, "images output") };
            case CapabilityKeys.ImageAnalysisCapabilityKey:
            case CapabilityKeys.ImageAnalysisStreamCapabilityKey:
                return { analysis: expectArrayForCapability<NormalizedImageAnalysis>(capability, output, "analysis output") };
            case CapabilityKeys.ImageEditStreamCapabilityKey:
                return undefined;
            default:
                return undefined;
        }
    }
}
