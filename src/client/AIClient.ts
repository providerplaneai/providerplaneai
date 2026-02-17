import {
    AIProvider,
    AIProviderType,
    AIRequest,
    AIResponse,
    AIResponseChunk,
    AppConfig,
    BaseProvider,
    CapabilityKeys,
    CapabilityMap,
    loadAppConfig,
    MultiModalExecutionContext,
    ProviderRef,
    withRequestContext,
    withRequestContextStream,
    AIClientLifecycleHooks,
    AllProvidersFailedError,
    AnthropicProvider,
    ClientChatRequest,
    ClientEmbeddingRequest,
    ClientImageAnalysisRequest,
    ClientImageEditRequest,
    ClientImageGenerationRequest,
    ClientModerationRequest,
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
    CapabilityKeyType,
    GenericJob,
    JobManager,
    JobLifecycleHooks
} from "#root/index.js";

/**
 * Main orchestrator and entry point for ProviderPlaneAI consumers.
 *
 * Responsibilities:
 * - Load and manage application configuration
 * - Register, initialize, and route to AI providers
 * - Enforce capability availability and fail-fast error handling
 * - Manage session lifecycle and event timelines
 * - Provide a unified, provider-agnostic interface for all AI capabilities (chat, embeddings, moderation, image, etc.)
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

    /**
     * Application configuration loaded from config files and environment variables.
     * Resolved once at construction and passed to providers during initialization.
     * AIClient does not interpret provider-specific config.
     */
    private appConfig: AppConfig;

    /** Optional lifecycle hooks for metrics and instrumentation */
    private lifeCycleHooks?: AIClientLifecycleHooks;

    constructor(private _jobManager = new JobManager()) {
        const appConfig = loadAppConfig();
        this.appConfig = appConfig;

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
    public findProvidersByCapability<C extends keyof CapabilityMap>(capability: C): (CapabilityMap[C] & BaseProvider)[] {
        const result: (CapabilityMap[C] & BaseProvider)[] = [];
        for (const providerMap of this.providers.values()) {
            for (const provider of providerMap.values()) {
                if (provider.hasCapability(capability)) {
                    result.push(provider as CapabilityMap[C] & BaseProvider);
                }
            }
        }
        return result;
    }

    public get jobManager() {
        return this._jobManager;
    }

    public createCapabilityJob<C extends CapabilityKeyType, TReq, TRes>(
        capability: C,
        request: AIRequest<TReq>,
        options?: {
            streaming?: boolean;
            providerChain?: ProviderRef[];
            addToManager?: boolean;
            lifecycleHooks?: JobLifecycleHooks<TRes>;
        }
    ): GenericJob<AIRequest<TReq>, TRes> {

        const job = new GenericJob<AIRequest<TReq>, TRes>(
            request,
            options?.streaming ?? false,
            async (input, ctx: MultiModalExecutionContext, signal, onChunk) => {

                if (options?.streaming) {
                    let finalOutput: TRes | undefined;

                    for await (const chunk of this.executeWithPolicyStream<C, TReq, TRes>(
                        capability, input, ctx,
                        (provider, cctx, sig) => (provider as CapabilityMap[C] & any)[capability](input, cctx, sig),
                        options?.providerChain
                    )) {
                        signal?.throwIfAborted();

                        if (chunk.multimodalArtifacts) {
                            ctx.yieldArtifacts(chunk.multimodalArtifacts);                    
                        }

                        if (chunk.delta && onChunk) {                            
                            onChunk({ delta: chunk.delta as unknown as TRes });
                        }

                        if (chunk.output !== undefined) {                                                    
                            finalOutput = chunk.output;
                        }
                    }

                    if (finalOutput !== undefined && onChunk) {
                        onChunk({ final: finalOutput });
                    }

                    return finalOutput as TRes;
                }

                const result = await this.executeWithPolicy<C, TReq, TRes>(
                    capability, input, ctx,
                    (provider, cctx, sig) => (provider as CapabilityMap[C] & any)[capability](input, cctx, sig),
                    options?.providerChain
                );

                return result.output as TRes;
            },
            options?.lifecycleHooks            
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
    async executeWithPolicy<C extends keyof CapabilityMap, TReq, TRes>(
        capability: C,
        request: AIRequest<TReq>,
        context: MultiModalExecutionContext,
        executeFn: (
            provider: CapabilityMap[C] & BaseProvider,
            ctx: MultiModalExecutionContext,
            signal?: AbortSignal) => Promise<AIResponse<TRes>>,
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
                const provider = this.getProvider<CapabilityMap[C] & BaseProvider>(providerType, connectionName);
                if (!provider.hasCapability(capability)) {
                    continue;
                }

                const signal = this.createExecutionSignal(request);

                const result: AIResponse<TRes> = await withRequestContext(request, () => executeFn(provider, context, signal));
                if (result.error) {
                    throw result.error;
                }

                if (result.output) {
                    this.applyOutputToContext(capability, result.output, context);
                }


                // Metrics hook: provider attempt success
                this.lifeCycleHooks?.onAttemptSuccess?.({
                    ...attemptCtx,
                    durationMs: Date.now() - startTime
                });
                this.lifeCycleHooks?.onExecutionEnd?.(capability, chain);

                return result;
            } catch (err) {
                const failure: ProviderAttemptResult = {
                    ...attemptCtx,
                    durationMs: Date.now() - startTime,
                    error: err instanceof Error ? err.message : String(err)
                };

                errors.push(failure);
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
    async *executeWithPolicyStream<C extends keyof CapabilityMap, TReq, TRes>(
        capability: C,
        request: AIRequest<TReq>,
        context: MultiModalExecutionContext,
        executeFn: (
            provider: CapabilityMap[C] & BaseProvider,
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
        this.lifeCycleHooks?.onExecutionStart?.(capability, chain);

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

            this.lifeCycleHooks?.onAttemptStart?.(attemptCtx);

            try {
                const provider = this.getProvider<CapabilityMap[C] & BaseProvider>(providerType, connectionName);
                if (!provider.hasCapability(capability)) {
                    continue;
                }

                const signal = this.createExecutionSignal(request);

                let chunkIndex = 0;
                let finalOutput: TRes | undefined;
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

                    yield chunk;

                    this.lifeCycleHooks?.onChunkEmitted?.({
                        capability,
                        providerType,
                        connectionName,
                        chunkIndex,
                        chunkTimeMs: Date.now() - startTime
                    });

                    chunkIndex++;
                }

                if (finalOutput !== undefined) {
                    this.applyOutputToContext(capability, finalOutput, context);
                }

                this.lifeCycleHooks?.onAttemptSuccess?.({
                    ...attemptCtx,
                    durationMs: Date.now() - startTime
                });

                this.lifeCycleHooks?.onExecutionEnd?.(capability, chain);
                return;
            } catch (err) {
                const failure: ProviderAttemptResult = {
                    ...attemptCtx,
                    durationMs: Date.now() - startTime,
                    error: err instanceof Error ? err.message : String(err)
                };

                errors.push(failure);
                this.lifeCycleHooks?.onAttemptFailure?.(failure);
            }
        }

        this.lifeCycleHooks?.onExecutionFailure?.(capability, chain, errors);
        this.lifeCycleHooks?.onExecutionEnd?.(capability, chain);

        throw new AllProvidersFailedError(capability, chain, errors);
    }

    private normalizeUserInput<T>(capability: keyof CapabilityMap, request: AIRequest<T>): NormalizedUserInput {
        return {
            id: crypto.randomUUID(),
            modality: this.modalityForCapability(capability),
            input: request.input,
            metadata: {
                requestId: request.context?.requestId
            }
        };
    }

    private modalityForCapability(capability: keyof CapabilityMap): NormalizedUserInput["modality"] {
        switch (capability) {
            case CapabilityKeys.ChatCapabilityKey:
            case CapabilityKeys.ChatStreamCapabilityKey: return "chat";
            case CapabilityKeys.EmbedCapabilityKey: return "embedding";
            case CapabilityKeys.ModerationCapabilityKey: return "moderation";
            case CapabilityKeys.ImageGenerationCapabilityKey:
            case CapabilityKeys.ImageGenerationStreamCapabilityKey: return "imageGeneration";
            case CapabilityKeys.ImageEditCapabilityKey:
            case CapabilityKeys.ImageEditStreamCapabilityKey: return "imageEdit";
            case CapabilityKeys.ImageAnalysisCapabilityKey:
            case CapabilityKeys.ImageAnalysisStreamCapabilityKey: return "imageAnalysis";
            default:
                throw new Error(`Unhandled capability modality: ${capability}`);
        }
    }

    private applyOutputToContext(
        capability: keyof CapabilityMap,
        output: unknown,
        context: MultiModalExecutionContext
    ) {
        switch (capability) {
            case CapabilityKeys.ChatCapabilityKey:
            case CapabilityKeys.ChatStreamCapabilityKey:
                context.applyAssistantMessage(output as NormalizedChatMessage);
                break;

            case CapabilityKeys.EmbedCapabilityKey:
                context.attachArtifacts({ embeddings: [output as NormalizedEmbedding] });
                break;

            case CapabilityKeys.ModerationCapabilityKey:
                context.attachArtifacts({ moderation: [output as NormalizedModeration] });
                break;

            case CapabilityKeys.ImageGenerationCapabilityKey:
            case CapabilityKeys.ImageGenerationCapabilityKey:
            case CapabilityKeys.ImageEditCapabilityKey:
                context.attachArtifacts({ images: output as NormalizedImage[] });
                break;

            case CapabilityKeys.ImageAnalysisCapabilityKey:
            case CapabilityKeys.ImageAnalysisStreamCapabilityKey:
                context.attachArtifacts({ analysis: output as NormalizedImageAnalysis[] });
                break;
            case CapabilityKeys.ImageGenerationStreamCapabilityKey:
            case CapabilityKeys.ImageEditStreamCapabilityKey:
                // no-op, artifacts already attached
                break;
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
                request.signal.addEventListener("abort", () => {
                    controller.abort(request.signal?.reason);
                });
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
     * Basic chat interface
     *
     * @param request The AIRequest payload for chat
     * @param context MultiModalExecutionContext for tracking history and events
     * @param providerChain Provider chain override
     * @returns AIResponse from the provider
     */
    async chat(
        request: AIRequest<ClientChatRequest>,
        context: MultiModalExecutionContext,
        providerChain?: ProviderRef[]
    ): Promise<AIResponse<NormalizedChatMessage>> {
        return this.executeWithPolicy<typeof CapabilityKeys.ChatCapabilityKey, ClientChatRequest, NormalizedChatMessage>(
            CapabilityKeys.ChatCapabilityKey,
            request,
            context,
            (provider, ctx, signal) => provider.chat(request, ctx, signal),
            providerChain
        );
    }

    /**
     * Streaming chat interface.
     * Streaming is modeled as an AsyncGenerator
     *
     * The client does not transform or buffer chunks.
     *
     * @param request The AIRequest payload for chat
     * @param context MultiModalExecutionContext for tracking history and events
     * @param providerChain Provider chain override
     * @returns AsyncGenerator yielding AIResponseChunk objects
     */
    async *chatStream(
        request: AIRequest<ClientChatRequest>,
        context: MultiModalExecutionContext,
        providerChain?: ProviderRef[]
    ): AsyncGenerator<AIResponseChunk<NormalizedChatMessage>> {
        yield* this.executeWithPolicyStream<typeof CapabilityKeys.ChatStreamCapabilityKey, ClientChatRequest, NormalizedChatMessage>(
            CapabilityKeys.ChatStreamCapabilityKey,
            request,
            context,
            (provider, ctx, signal) => provider.chatStream(request, ctx, signal),
            providerChain
        );
    }

    /**
     * Embedding generation interface.
     *
     * Embeddings are treated as a first-class capability rather than
     * an optional chat feature to keep the capability model orthogonal.
     *
     * @param request The AIRequest payload for embedding generation
     * @param context MultiModalExecutionContext for tracking history and events
     * @param providerChain Provider chain override
     * @returns AIResponse containing embeddings
     */
    async embeddings(
        request: AIRequest<ClientEmbeddingRequest>,
        context: MultiModalExecutionContext,
        providerChain?: ProviderRef[]
    ): Promise<AIResponse<NormalizedEmbedding[]>> {
        return this.executeWithPolicy<typeof CapabilityKeys.EmbedCapabilityKey, ClientEmbeddingRequest, NormalizedEmbedding[]>(
            CapabilityKeys.EmbedCapabilityKey,
            request,
            context,
            (provider, ctx, signal) => provider.embed(request, ctx, signal),
            providerChain
        );
    }

    /**
     * Moderation interface.
     *
     * Moderation is intentionally isolated as its own capability to allow:
     * - Independent provider support
     * - Future policy-driven routing
     *
     * @param request The AIRequest payload for moderation
     * @param context MultiModalExecutionContext for tracking history and events
     * @param providerChain Provider chain override
     * @returns AIResponse containing moderation results
     */
    async moderation(
        request: AIRequest<ClientModerationRequest>,
        context: MultiModalExecutionContext,
        providerChain?: ProviderRef[]
    ): Promise<AIResponse<NormalizedModeration[]>> {
        return this.executeWithPolicy<
            typeof CapabilityKeys.ModerationCapabilityKey,
            ClientModerationRequest,
            NormalizedModeration[]
        >(
            CapabilityKeys.ModerationCapabilityKey,
            request,
            context,
            (provider, ctx, signal) => provider.moderation(request, ctx, signal),
            providerChain
        );
    }

    /**
     * Image generation (non-streaming).
     *
     * @param request The AIRequest payload for image generation
     * @param context MultiModalExecutionContext for tracking history and events
     * @param providerChain Provider chain override
     * @returns AIResponse containing generated image data
     */
    async generateImage(
        request: AIRequest<ClientImageGenerationRequest>,
        context: MultiModalExecutionContext,
        providerChain?: ProviderRef[]
    ): Promise<AIResponse<NormalizedImage[]>> {
        return this.executeWithPolicy<
            typeof CapabilityKeys.ImageGenerationCapabilityKey,
            ClientImageGenerationRequest,
            NormalizedImage[]
        >(
            CapabilityKeys.ImageGenerationCapabilityKey,
            request,
            context,
            (provider, ctx, signal) => provider.generateImage(request, ctx, signal),
            providerChain
        );
    }

    /**
     * Streaming image generation interface.
     *
     * Included for API symmetry and future expansion, even though
     * current provider support is limited.
     *
     * @param request The AIRequest payload for image generation
     * @param context MultiModalExecutionContext for tracking history and events
     * @param providerChain Provider chain override
     * @returns AsyncGenerator yielding AIResponseChunk objects
     * @throws Error if the provider does not support image generation streaming capability
     */
    async *generateImageStream(
        request: AIRequest<ClientImageGenerationRequest>,
        context: MultiModalExecutionContext,
        providerChain?: ProviderRef[]
    ): AsyncGenerator<AIResponseChunk<NormalizedImage[]>> {
        yield* this.executeWithPolicyStream<
            typeof CapabilityKeys.ImageGenerationStreamCapabilityKey,
            ClientImageGenerationRequest,
            NormalizedImage[]
        >(
            CapabilityKeys.ImageGenerationStreamCapabilityKey,
            request,
            context,
            (provider, ctx) => provider.generateImageStream(request, ctx),
            providerChain
        );
    }

    /**
     * Image analysis interface.
     *
     * @param request The AIRequest payload for image analysis
     * @param context MultiModalExecutionContext for tracking history and events
     * @param providerChain Provider chain override
     * @returns AIResponse containing generated image data
     */
    async analyzeImage(
        request: AIRequest<ClientImageAnalysisRequest>,
        context: MultiModalExecutionContext,
        providerChain?: ProviderRef[]
    ): Promise<AIResponse<NormalizedImageAnalysis[]>> {
        return this.executeWithPolicy<
            typeof CapabilityKeys.ImageAnalysisCapabilityKey,
            ClientImageAnalysisRequest,
            NormalizedImageAnalysis[]
        >(
            CapabilityKeys.ImageAnalysisCapabilityKey,
            request,
            context,
            (provider, ctx, signal) => provider.analyzeImage(request, ctx, signal),
            providerChain
        );
    }

    /**
     * Streaming image analysis interface.
     *
     * Included for API symmetry and future expansion, even though
     * current provider support is limited.
     *
     * @param request The AIRequest payload for image analysis
     * @param context MultiModalExecutionContext for tracking history and events
     * @param providerChain Provider chain override
     * @returns AsyncGenerator yielding AIResponseChunk objects
     */
    async *analyzeImageStream(
        request: AIRequest<ClientImageAnalysisRequest>,
        context: MultiModalExecutionContext,
        providerChain?: ProviderRef[]
    ): AsyncGenerator<AIResponseChunk<NormalizedImageAnalysis[]>> {
        yield* this.executeWithPolicyStream<
            typeof CapabilityKeys.ImageAnalysisStreamCapabilityKey,
            ClientImageAnalysisRequest,
            NormalizedImageAnalysis[]
        >(
            CapabilityKeys.ImageAnalysisStreamCapabilityKey,
            request,
            context,
            (provider, ctx, signal) => provider.analyzeImageStream(request, ctx, signal),
            providerChain
        );
    }

    /**
     * Image editing (non-streaming).
     *
     * @param request The AIRequest payload for image editing
     * @param context MultiModalExecutionContext for tracking history and events
     * @param providerChain Provider chain override
     * @returns AIResponse containing edited image data
     */
    async editImage(
        request: AIRequest<ClientImageEditRequest>,
        context: MultiModalExecutionContext,
        providerChain?: ProviderRef[]
    ): Promise<AIResponse<NormalizedImage[]>> {
        return this.executeWithPolicy<typeof CapabilityKeys.ImageEditCapabilityKey, ClientImageEditRequest, NormalizedImage[]>(
            CapabilityKeys.ImageEditCapabilityKey,
            request,
            context,
            (provider, ctx, signal) => provider.editImage(request, ctx, signal),
            providerChain
        );
    }

    /**
     * Streaming image edit interface.
     *
     * @param request The AIRequest payload for image editing
     * @param context MultiModalExecutionContext for tracking history and events
     * @param providerChain Provider chain override
     * @returns AsyncGenerator yielding AIResponseChunk objects
     */
    async *editImageStream(
        request: AIRequest<ClientImageEditRequest>,
        context: MultiModalExecutionContext,
        providerChain?: ProviderRef[]
    ): AsyncGenerator<AIResponseChunk<NormalizedImage[]>> {
        yield* this.executeWithPolicyStream<
            typeof CapabilityKeys.ImageEditStreamCapabilityKey,
            ClientImageEditRequest,
            NormalizedImage[]
        >(
            CapabilityKeys.ImageEditStreamCapabilityKey,
            request,
            context,
            (provider, ctx, signal) => provider.editImageStream(request, ctx, signal),
            providerChain
        );
    }
    /*
        async generateAudio(
            request: AIRequest<ClientAudioRequest>,
            context: MultiModalExecutionContext,
            providerChain?: ProviderRef[]
        ): Promise<AIResponse<NormalizedAudio[]>> { ... }
    
        async generateVideo(
            request: AIRequest<ClientVideoRequest>,
            context: MultiModalExecutionContext,
            providerChain?: ProviderRef[]
        ): Promise<AIResponse<NormalizedVideo[]>> { ... }
    
        async uploadFile(
            request: AIRequest<ClientFileRequest>,
            context: MultiModalExecutionContext,
            providerChain?: ProviderRef[]
        ): Promise<AIResponse<NormalizedFile[]>> { ... }*/
}

