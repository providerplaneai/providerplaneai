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
    AISession,
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
    ModerationResult,
    NormalizedImage,
    NormalizedImageAnalysis,
    OpenAIProvider,
    ProviderAttemptContext,
    ProviderAttemptResult,
    SessionEvent,
    SessionSerializer,
    SessionSnapshot
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

    /** In-memory sessions registry */
    private readonly sessions = new Map<string, AISession>();

    /**
     * Application configuration loaded from config files and environment variables.
     * Resolved once at construction and passed to providers during initialization.
     * AIClient does not interpret provider-specific config.
     */
    private appConfig: AppConfig;

    /** Optional lifecycle hooks for metrics and instrumentation */
    private lifeCycleHooks?: AIClientLifecycleHooks;

    constructor() {
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
        this.lifeCycleHooks = lifeCycleHooks;
    }

    /** Create a new session */
    createSession(id?: string): AISession {
        const session = new AISession(id);
        this.sessions.set(session.id, session);
        return session;
    }

    /** Get an existing session by ID */
    getSession(id: string): AISession | undefined {
        return this.sessions.get(id);
    }

    /** Get existing session by ID, or create a new one if not found */
    getOrCreateSession(id?: string): AISession {
        if (!id) {
            return this.createSession();
        }
        return this.sessions.get(id) ?? this.createSession(id);
    }

    /** Resume a session from a snapshot */
    resumeSession(snapshot: SessionSnapshot): AISession {
        const session = SessionSerializer.deserialize(snapshot).session;
        this.sessions.set(session.id, session);
        return session;
    }

    /** Serialize a session by ID */
    serializeSession(id: string): SessionSnapshot {
        const session = this.sessions.get(id);
        if (!session) {
            throw new Error(`Session not found: ${id}`);
        }
        return SessionSerializer.serialize(session);
    }

    /** Close a session by ID */
    closeSession(id: string): void {
        this.sessions.delete(id);
    }

    /** List all active session IDs */
    listSessions(): string[] {
        return Array.from(this.sessions.keys());
    }

    /**
     * Emit a session event (request, response, chunk, etc.) with generated ID and timestamp.
     */
    private emitSessionData<TPayload>(session: AISession, e: Omit<SessionEvent<TPayload>, "id" | "timestamp">) {
        session.addEvent({
            id: crypto.randomUUID(),
            timestamp: Date.now(),
            ...e
        });
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

    /**
     * Executes a capability call across a provider chain with fallback support.
     *
     * @template C Capability key (e.g., ChatCapability, ImageAnalysisCapability)
     * @param capability The capability being invoked
     * @param request The request object created by the caller
     * @param session The session to attach this request to
     * @param executeFn Function that executes the call on a provider
     * @param providerChain Optional ordered list of providers to try; defaults to appConfig.executionPolicy.providerChain
     * @returns Result of the first successful provider call
     * @throws AllProvidersFailedError if all providers fail
     */
    async executeWithPolicy<C extends keyof CapabilityMap, TReq, TRes>(
        capability: C,
        request: AIRequest<TReq>,
        session: AISession,
        executeFn: (provider: CapabilityMap[C] & BaseProvider, ctx: MultiModalExecutionContext) => Promise<AIResponse<TRes>>,
        providerChain?: ProviderRef[]
    ): Promise<AIResponse<TRes>> {
        // Use chain from config if none explicitly provided
        const chain: ProviderRef[] = providerChain ?? this.appConfig.appConfig?.executionPolicy?.providerChain ?? [];
        if (!chain.length) {
            throw new ExecutionPolicyError(`No provider chain defined in execution policy for capability: ${capability}`);
        }

        const context = session.getContext();

        // Begin the turn once before provider iteration
        context.beginTurn(request.input);

        // Log request in session
        this.emitSessionData(session, {
            eventType: "request",
            capability,
            payload: request.input
        });

        const errors: ProviderAttemptResult[] = [];

        // Metrics hook: provider attempt start
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

                // Execute provider
                const result: AIResponse<TRes> = await withRequestContext(request, () => executeFn(provider, context));

                if (result.metadata?.status === "completed" || result.metadata?.status === "incomplete") {
                    // Apply output to context (context is state-only)
                    context.applyOutput(result.output, result.multimodalArtifacts);

                    // Log response in session
                    this.emitSessionData(session, {
                        eventType: "response",
                        capability,
                        payload: result?.output
                    });

                    // Metrics hook: provider attempt success
                    this.lifeCycleHooks?.onAttemptSuccess?.({
                        ...attemptCtx,
                        durationMs: Date.now() - startTime
                    });
                } else {
                    throw new Error(`Provider returned unexpected status: ${result.metadata?.status}`);
                }

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
     * @param session The session to attach this request to
     * @param executeFn Function that executes the call on a provider and returns an AsyncGenerator
     * @param providerChain Optional ordered list of providers to try; defaults to appConfig.executionPolicy.providerChain
     * @returns AsyncGenerator yielding chunks from the first successful provider
     * @throws AllProvidersFailedError if all providers fail immediately
     */
    async *executeWithPolicyStream<C extends keyof CapabilityMap, TReq, TRes>(
        capability: C,
        request: AIRequest<TReq>,
        session: AISession,
        executeFn: (
            provider: CapabilityMap[C] & BaseProvider,
            ctx: MultiModalExecutionContext
        ) => AsyncGenerator<AIResponseChunk<TRes>>,
        providerChain?: ProviderRef[]
    ): AsyncGenerator<AIResponseChunk<TRes>> {
        const chain = providerChain ?? this.appConfig.appConfig?.executionPolicy?.providerChain ?? [];
        if (!chain.length) {
            throw new ExecutionPolicyError(`No provider chain defined for ${capability}`);
        }

        const context = session.getContext();

        // Begin the turn once before provider iteration
        context.beginTurn(request.input);

        this.emitSessionData(session, {
            eventType: "request",
            capability,
            payload: request.input
        });

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

                let chunkIndex = 0;
                let finalOutput: TRes | undefined;
                for await (const chunk of withRequestContextStream(request, () => executeFn(provider, context))) {
                    // Attach any multimodal artifacts incrementally
                    if (chunk.multimodalArtifacts) {
                        context.attachMultimodalArtifacts(chunk.multimodalArtifacts);
                    }

                    // Apply partial output to session (state-only)
                    this.emitSessionData(session, {
                        eventType: "chunk",
                        capability,
                        payload: chunk.delta
                    });

                    // Track the final output if this chunk signals completion
                    if (chunk.metadata?.status === "completed" || chunk.metadata?.status === "incomplete") {
                        finalOutput = chunk.output;
                    }

                    yield chunk;

                    chunkIndex++;
                    this.lifeCycleHooks?.onChunkEmitted?.({
                        capability,
                        providerType,
                        connectionName,
                        chunkIndex,
                        chunkTimeMs: Date.now() - startTime
                    });
                }

                if (finalOutput === undefined) {
                    throw new Error(`Provider stream finished without producing a final output`);
                }

                // Apply final output to context
                context.applyOutput(finalOutput);

                // Emit final response to session
                this.emitSessionData(session, {
                    eventType: "response",
                    capability,
                    payload: finalOutput
                });

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

    /**
     * Basic chat interface
     *
     * @param request The AIRequest payload for chat
     * @param session AISession for tracking history and events
     * @param providerChain Provider chain override
     * @returns AIResponse from the provider
     */
    async chat(
        request: AIRequest<ClientChatRequest>,
        session: AISession,
        providerChain?: ProviderRef[]
    ): Promise<AIResponse<string[]>> {
        const outputs: string[] = [];
        const rawResponses: any[] = [];
        const { input } = request;

        // Send one message at a time and aggregate results
        for (const msg of input.messages) {
            const singleMessageRequest: AIRequest<ClientChatRequest> = {
                ...request,
                input: { messages: [msg] }
            };

            const result = await this.executeWithPolicy<typeof CapabilityKeys.ChatCapabilityKey, ClientChatRequest, string>(
                CapabilityKeys.ChatCapabilityKey,
                singleMessageRequest,
                session,
                (provider, ctx) => provider.chat(singleMessageRequest, ctx),
                providerChain
            );

            outputs.push(result.output);
            rawResponses.push(result.rawResponse);
        }

        return {
            ...request,
            output: outputs,
            rawResponse: rawResponses,
            id: `multi-${crypto.randomUUID()}`,
            metadata: {
                provider: "aggregated",
                status: "completed"
            }
        };
    }

    /**
     * Streaming chat interface.
     * Streaming is modeled as an AsyncGenerator
     *
     * The client does not transform or buffer chunks.
     *
     * @param request The AIRequest payload for chat
     * @param session AISession for tracking history and events
     * @param providerChain Provider chain override
     * @returns AsyncGenerator yielding AIResponseChunk objects
     */
    async *chatStream(
        request: AIRequest<ClientChatRequest>,
        session: AISession,
        providerChain?: ProviderRef[]
    ): AsyncGenerator<AIResponseChunk<string>> {
        const { input } = request;
        for (const msg of input.messages) {
            const singleMessageRequest: AIRequest<ClientChatRequest> = {
                ...request,
                input: { messages: [msg] }
            };

            yield* this.executeWithPolicyStream<typeof CapabilityKeys.ChatStreamCapabilityKey, ClientChatRequest, string>(
                CapabilityKeys.ChatStreamCapabilityKey,
                singleMessageRequest,
                session,
                (provider, ctx) => provider.chatStream(singleMessageRequest, ctx),
                providerChain
            );
        }
    }

    /**
     * Embedding generation interface.
     *
     * Embeddings are treated as a first-class capability rather than
     * an optional chat feature to keep the capability model orthogonal.
     *
     * @param request The AIRequest payload for embedding generation
     * @param session AISession for tracking history and events
     * @param providerChain Provider chain override
     * @returns AIResponse containing embeddings
     */
    async embeddings(
        request: AIRequest<ClientEmbeddingRequest>,
        session: AISession,
        providerChain?: ProviderRef[]
    ): Promise<AIResponse<number[] | number[][]>> {
        return this.executeWithPolicy<typeof CapabilityKeys.EmbedCapabilityKey, ClientEmbeddingRequest, number[] | number[][]>(
            CapabilityKeys.EmbedCapabilityKey,
            request,
            session,
            (provider, ctx) => provider.embed(request, ctx),
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
     * @param session AISession for tracking history and events
     * @param providerChain Provider chain override
     * @returns AIResponse containing moderation results
     */
    async moderation(
        request: AIRequest<ClientModerationRequest>,
        session: AISession,
        providerChain?: ProviderRef[]
    ): Promise<AIResponse<ModerationResult | ModerationResult[]>> {
        return this.executeWithPolicy<
            typeof CapabilityKeys.ModerationCapabilityKey,
            ClientModerationRequest,
            ModerationResult | ModerationResult[]
        >(
            CapabilityKeys.ModerationCapabilityKey,
            request,
            session,
            (provider, ctx) => provider.moderation(request, ctx),
            providerChain
        );
    }

    /**
     * Image generation (non-streaming).
     *
     * @param request The AIRequest payload for image generation
     * @param session AISession for tracking history and events
     * @param providerChain Provider chain override
     * @returns AIResponse containing generated image data
     */
    async generateImage(
        request: AIRequest<ClientImageGenerationRequest>,
        session: AISession,
        providerChain?: ProviderRef[]
    ): Promise<AIResponse<NormalizedImage[]>> {
        return this.executeWithPolicy<
            typeof CapabilityKeys.ImageGenerationCapabilityKey,
            ClientImageGenerationRequest,
            NormalizedImage[]
        >(
            CapabilityKeys.ImageGenerationCapabilityKey,
            request,
            session,
            (provider, ctx) => provider.generateImage(request, ctx),
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
     * @param session AISession for tracking history and events
     * @param providerChain Provider chain override
     * @returns AsyncGenerator yielding AIResponseChunk objects
     * @throws Error if the provider does not support image generation streaming capability
     */
    async *generateImageStream(
        request: AIRequest<ClientImageGenerationRequest>,
        session: AISession,
        providerChain?: ProviderRef[]
    ): AsyncGenerator<AIResponseChunk<NormalizedImage[]>> {
        yield* this.executeWithPolicyStream<
            typeof CapabilityKeys.ImageGenerationStreamCapabilityKey,
            ClientImageGenerationRequest,
            NormalizedImage[]
        >(
            CapabilityKeys.ImageGenerationStreamCapabilityKey,
            request,
            session,
            (provider, ctx) => provider.generateImageStream(request, ctx),
            providerChain
        );
    }

    /**
     * Image analysis interface.
     *
     * @param request The AIRequest payload for image analysis
     * @param session AISession for tracking history and events
     * @param providerChain Provider chain override
     * @returns AIResponse containing generated image data
     */
    async analyzeImage(
        request: AIRequest<ClientImageAnalysisRequest>,
        session: AISession,
        providerChain?: ProviderRef[]
    ): Promise<AIResponse<NormalizedImageAnalysis[]>> {
        return this.executeWithPolicy<
            typeof CapabilityKeys.ImageAnalysisCapabilityKey,
            ClientImageAnalysisRequest,
            NormalizedImageAnalysis[]
        >(
            CapabilityKeys.ImageAnalysisCapabilityKey,
            request,
            session,
            (provider, ctx) => provider.analyzeImage(request, ctx),
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
     * @param session AISession for tracking history and events
     * @param providerChain Provider chain override
     * @returns AsyncGenerator yielding AIResponseChunk objects
     */
    async *analyzeImageStream(
        request: AIRequest<ClientImageAnalysisRequest>,
        session: AISession,
        providerChain?: ProviderRef[]
    ): AsyncGenerator<AIResponseChunk<NormalizedImageAnalysis[]>> {
        yield* this.executeWithPolicyStream<
            typeof CapabilityKeys.ImageAnalysisStreamCapabilityKey,
            ClientImageAnalysisRequest,
            NormalizedImageAnalysis[]
        >(
            CapabilityKeys.ImageAnalysisStreamCapabilityKey,
            request,
            session,
            (provider, ctx) => provider.analyzeImageStream(request, ctx),
            providerChain
        );
    }

    /**
     * Image editing (non-streaming).
     *
     * @param request The AIRequest payload for image editing
     * @param session AISession for tracking history and events
     * @param providerChain Provider chain override
     * @returns AIResponse containing edited image data
     */
    async editImage(
        request: AIRequest<ClientImageEditRequest>,
        session: AISession,
        providerChain?: ProviderRef[]
    ): Promise<AIResponse<NormalizedImage[]>> {
        return this.executeWithPolicy<typeof CapabilityKeys.ImageEditCapabilityKey, ClientImageEditRequest, NormalizedImage[]>(
            CapabilityKeys.ImageEditCapabilityKey,
            request,
            session,
            (provider, ctx) => provider.editImage(request, ctx),
            providerChain
        );
    }

    /**
     * Streaming image edit interface.
     *
     * @param request The AIRequest payload for image editing
     * @param session AISession for tracking history and events
     * @param providerChain Provider chain override
     * @returns AsyncGenerator yielding AIResponseChunk objects
     */
    async *editImageStream(
        request: AIRequest<ClientImageEditRequest>,
        session: AISession,
        providerChain?: ProviderRef[]
    ): AsyncGenerator<AIResponseChunk<NormalizedImage[]>> {
        yield* this.executeWithPolicyStream<
            typeof CapabilityKeys.ImageEditStreamCapabilityKey,
            ClientImageEditRequest,
            NormalizedImage[]
        >(
            CapabilityKeys.ImageEditStreamCapabilityKey,
            request,
            session,
            (provider, ctx) => provider.editImageStream(request, ctx),
            providerChain
        );
    }
}
