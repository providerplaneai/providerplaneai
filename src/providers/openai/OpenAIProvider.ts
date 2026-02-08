import OpenAI from "openai";
import {
    AIProvider,
    AIRequest,
    AIResponse,
    AIResponseChunk,
    BaseProvider,
    CapabilityKeys,
    CapabilityUnsupportedError,
    ChatCapability,
    ChatStreamCapability,
    ClientChatRequest,
    ClientEmbeddingRequest,
    ClientImageAnalysisRequest,
    ClientImageEditRequest,
    ClientImageGenerationRequest,
    ClientModerationRequest,
    EmbedCapability,
    ImageAnalysisCapability,
    ImageAnalysisStreamCapability,
    ImageEditCapability,
    ImageEditStreamCapability,
    ImageGenerationCapability,
    ImageGenerationStreamCapability,
    ModerationCapability,
    MultiModalExecutionContext,
    NormalizedChatMessage,
    NormalizedEmbedding,
    NormalizedImage,
    NormalizedImageAnalysis,
    NormalizedModeration,
    OpenAIChatCapabilityImpl,
    OpenAIEmbedCapabilityImpl,
    OpenAIImageAnalysisCapabilityImpl,
    OpenAIImageEditCapabilityImpl,
    OpenAIImageGenerationCapabilityImpl,
    OpenAIModerationCapabilityImpl,
    ProviderConnectionConfig
} from "#root/index.js";

/**
 * OpenAIProvider: Concrete BaseProvider implementation for OpenAI models.
 *
 * Responsibilities:
 * - Owns the OpenAI SDK client
 * - Initializes provider configuration and credentials
 * - Registers supported capabilities
 * - Delegates execution to capability-specific implementations
 *
 * Implements chat, embedding, image, and moderation capabilities for OpenAI.
 */
export class OpenAIProvider
    extends BaseProvider
    implements
        ChatCapability<ClientChatRequest>,
        EmbedCapability<ClientEmbeddingRequest>,
        ModerationCapability<ClientModerationRequest>,
        ImageGenerationCapability<ClientImageGenerationRequest>,
        ImageGenerationStreamCapability<ClientImageGenerationRequest>,
        ImageAnalysisCapability<ClientImageAnalysisRequest>,
        ImageAnalysisStreamCapability<ClientImageAnalysisRequest>,
        ImageEditCapability<ClientImageEditRequest>,
        ImageEditStreamCapability<ClientImageEditRequest>
{
    /** Underlying OpenAI SDK client */
    private client: OpenAI | null = null;

    /** Capability delegate implementations */
    private chatDelegate: OpenAIChatCapabilityImpl | null = null;
    private embedDelegate: OpenAIEmbedCapabilityImpl | null = null;
    private moderateDelegate: OpenAIModerationCapabilityImpl | null = null;
    private imageEditDelegate: OpenAIImageEditCapabilityImpl | null = null;
    private imageGenDelegate: OpenAIImageGenerationCapabilityImpl | null = null;
    private imageAnalysisDelegate: OpenAIImageAnalysisCapabilityImpl | null = null;

    public constructor() {
        super(AIProvider.OpenAI);
    }

    /**
     * Initializes the OpenAI provider and registers supported capabilities.
     *
     * @param config - Provider connection configuration
     * @throws Error if API key is missing or invalid
     */
    override init(config: ProviderConnectionConfig) {
        console.log(`Initializing OpenAI Provider`);

        // Initialization logic for OpenAI provider`
        if (!config.apiKey) {
            throw new Error(`OpenAI API key ${config.apiKeyEnvVar} required but not found in config. Check .env file`);
        }
        this.config = config;
        this.client = new OpenAI({
            apiKey: config.apiKey,
            ...(config.providerDefaults?.providerParams ?? {})
        });

        // Initialize capability delegates
        this.chatDelegate = new OpenAIChatCapabilityImpl(this, this.client);
        this.embedDelegate = new OpenAIEmbedCapabilityImpl(this, this.client);
        this.moderateDelegate = new OpenAIModerationCapabilityImpl(this, this.client);
        this.imageEditDelegate = new OpenAIImageEditCapabilityImpl(this, this.client);
        this.imageGenDelegate = new OpenAIImageGenerationCapabilityImpl(this, this.client);
        this.imageAnalysisDelegate = new OpenAIImageAnalysisCapabilityImpl(this, this.client);

        // Register supported capabilities
        this.registerCapability(
            CapabilityKeys.ChatCapabilityKey, 
            this as ChatCapability<ClientChatRequest, NormalizedChatMessage>);
        this.registerCapability(
            CapabilityKeys.ChatStreamCapabilityKey,
            this as ChatStreamCapability<ClientChatRequest, NormalizedChatMessage>
        );
        this.registerCapability(
            CapabilityKeys.EmbedCapabilityKey,
            this as EmbedCapability<ClientEmbeddingRequest, NormalizedEmbedding[]>
        );
        this.registerCapability(
            CapabilityKeys.ModerationCapabilityKey,
            this as ModerationCapability<ClientModerationRequest, NormalizedModeration[]>
        );
        this.registerCapability(
            CapabilityKeys.ImageGenerationCapabilityKey,
            this as ImageGenerationCapability<ClientImageGenerationRequest, NormalizedImage[]>
        );
        this.registerCapability(
            CapabilityKeys.ImageGenerationStreamCapabilityKey,
            this as ImageGenerationStreamCapability<ClientImageGenerationRequest, NormalizedImage[]>
        );
        this.registerCapability(
            CapabilityKeys.ImageEditCapabilityKey,
            this as ImageEditCapability<ClientImageEditRequest, NormalizedImage[]>
        );
        this.registerCapability(
            CapabilityKeys.ImageEditStreamCapabilityKey,
            this as ImageEditStreamCapability<ClientImageEditRequest, NormalizedImage[]>
        );
        this.registerCapability(
            CapabilityKeys.ImageAnalysisCapabilityKey,
            this as ImageAnalysisCapability<ClientImageAnalysisRequest, NormalizedImageAnalysis[]>
        );
        this.registerCapability(
            CapabilityKeys.ImageAnalysisStreamCapabilityKey,
            this as ImageAnalysisStreamCapability<ClientImageAnalysisRequest, NormalizedImageAnalysis[]>
        );
    }

    /**
     * Execute a non-streaming chat request.
     *
     * @template TChatInput Chat input type
     * @param req - Unified AI request containing chat input and options
     * @param executionContext Execution context
     * @param signal AbortSignal for request cancellation
     * @returns AIResponse containing generated text
     */
    async chat(
        req: AIRequest<ClientChatRequest>, 
        executionContext: MultiModalExecutionContext, 
        signal?: AbortSignal
    ): Promise<AIResponse<NormalizedChatMessage>> {
        if (!this.chatDelegate || typeof this.chatDelegate.chat !== "function") {
            throw new CapabilityUnsupportedError(this.providerType, CapabilityKeys.ChatCapabilityKey);
        }
        return await this.chatDelegate.chat(req, executionContext, signal);
    }

    /**
     * Execute a streaming chat request.
     *
     * @template TChatInput Chat input type
     * @param req - Unified AI request containing chat input and options
     * @param executionContext Execution context
     * @param signal AbortSignal for request cancellation
     * @returns Async iterable emitting streamed response chunks
     */
    chatStream(
        req: AIRequest<ClientChatRequest>,
        executionContext: MultiModalExecutionContext,
        signal?: AbortSignal
    ): AsyncGenerator<AIResponseChunk<NormalizedChatMessage>> {
        if (!this.chatDelegate || typeof this.chatDelegate.chatStream !== "function") {
            throw new CapabilityUnsupportedError(this.providerType, CapabilityKeys.ChatStreamCapabilityKey);
        }
        return this.chatDelegate.chatStream(req, executionContext, signal);
    }

    /**
     * Execute an embedding request.
     *
     * @template TEmbedInput Embedding input type
     * @param req - Unified AI request containing embedding input
     * @param executionContext Execution context
     * @param signal AbortSignal for request cancellation
     * @returns AIResponse containing embedding vector(s)
     */
    async embed(
        req: AIRequest<ClientEmbeddingRequest>,
        executionContext: MultiModalExecutionContext,
        signal?: AbortSignal
    ): Promise<AIResponse<NormalizedEmbedding[]>> {
        if (!this.embedDelegate || typeof this.embedDelegate.embed !== "function") {
            throw new CapabilityUnsupportedError(this.providerType, CapabilityKeys.EmbedCapabilityKey);
        }
        return await this.embedDelegate.embed(req, executionContext, signal);
    }

    /**
     * Execute a moderation request.
     *
     * @template TModerationInput Moderation input type
     * @param req - Unified AI request containing moderation input
     * @param executionContext Execution context
     * @param signal AbortSignal for request cancellation
     * @returns AIResponse containing moderation result(s)
     */
    async moderation(
        req: AIRequest<ClientModerationRequest>,
        executionContext: MultiModalExecutionContext,
        signal?: AbortSignal
    ): Promise<AIResponse<NormalizedModeration[]>> {
        if (!this.moderateDelegate || typeof this.moderateDelegate.moderation !== "function") {
            throw new CapabilityUnsupportedError(this.providerType, CapabilityKeys.ModerationCapabilityKey);
        }
        return await this.moderateDelegate.moderation(req, executionContext, signal);
    }

    /**
     * Execute a non-streaming image generation request.
     *
     * @template TImageInput Image generation input type
     * @param req - Unified AI request containing image generation input
     * @param executionContext Execution context
     * @param signal AbortSignal for request cancellation
     * @returns AIResponse containing normalized generated images
     */
    async generateImage(
        req: AIRequest<ClientImageGenerationRequest>,
        executionContext: MultiModalExecutionContext,
        signal?: AbortSignal
    ): Promise<AIResponse<NormalizedImage[]>> {
        if (!this.imageGenDelegate || typeof this.imageGenDelegate.generateImage !== "function") {
            throw new CapabilityUnsupportedError(this.providerType, CapabilityKeys.ImageGenerationCapabilityKey);
        }
        return await this.imageGenDelegate.generateImage(req, executionContext, signal);
    }

    /**
     * Execute a streaming image generation request.
     *
     * @template TImageInput Image generation input type
     * @param req - Unified AI request containing image generation input
     * @param executionContext Execution context
     * @param signal AbortSignal for request cancellation
     * @returns Async iterable emitting image generation chunks
     */
    generateImageStream(
        req: AIRequest<ClientImageGenerationRequest>,
        executionContext: MultiModalExecutionContext,
        signal?: AbortSignal
    ): AsyncGenerator<AIResponseChunk<NormalizedImage[]>> {
        if (!this.imageGenDelegate || typeof this.imageGenDelegate.generateImageStream !== "function") {
            throw new CapabilityUnsupportedError(this.providerType, CapabilityKeys.ImageGenerationStreamCapabilityKey);
        }
        return this.imageGenDelegate.generateImageStream(req, executionContext, signal);
    }

    /**
     * Non-streaming image edit request
     *
     * @template TImageEditInput Image edit input type
     * @param req - Unified AI request containing image edit input
     * @param executionContext Execution context
     * @param signal AbortSignal for request cancellation
     * @returns AIResponse containing normalized edited images
     */
    async editImage(
        request: AIRequest<ClientImageEditRequest>,
        executionContext: MultiModalExecutionContext,
        signal?: AbortSignal
    ): Promise<AIResponse<NormalizedImage[]>> {
        if (!this.imageEditDelegate || typeof this.imageEditDelegate.editImage !== "function") {
            throw new CapabilityUnsupportedError(this.providerType, CapabilityKeys.ImageEditCapabilityKey);
        }
        return this.imageEditDelegate.editImage(request, executionContext, signal);
    }

    /**
     * Non-streaming image edit request
     *
     * @template TImageEditInput Image edit input type
     * @param req - Unified AI request containing image edit input
     * @param executionContext Execution context
     * @param signal AbortSignal for request cancellation
     * @returns Async iterable emitting image edit chunks
     */
    editImageStream(
        req: AIRequest<ClientImageEditRequest>,
        executionContext: MultiModalExecutionContext,
        signal?: AbortSignal
    ): AsyncGenerator<AIResponseChunk<NormalizedImage[]>> {
        if (!this.imageEditDelegate || typeof this.imageEditDelegate.editImageStream !== "function") {
            throw new CapabilityUnsupportedError(this.providerType, CapabilityKeys.ImageEditStreamCapabilityKey);
        }
        return this.imageEditDelegate.editImageStream(req, executionContext, signal);
    }

    /**
     * Execute an image analysis request
     *
     * @template TImageAnalysisInput Image analysis input type
     * @param req - Unified AI request containing Image analysis input and options
     * @param executionContext Execution context
     * @param signal AbortSignal for request cancellation
     * @returns AIResponse containing normalized image analysis
     */
    async analyzeImage(
        req: AIRequest<ClientImageAnalysisRequest>,
        executionContext: MultiModalExecutionContext,
        signal?: AbortSignal
    ): Promise<AIResponse<NormalizedImageAnalysis[]>> {
        if (!this.imageAnalysisDelegate || typeof this.imageAnalysisDelegate.analyzeImage !== "function") {
            throw new CapabilityUnsupportedError(this.providerType, CapabilityKeys.ImageAnalysisCapabilityKey);
        }
        return await this.imageAnalysisDelegate.analyzeImage(req, executionContext, signal);
    }

    /**
     * Execute a streaming image analysis request
     *
     * @template TImageAnalysisInput Image analysis input type
     * @param req - Unified AI request containing Image analysis input and options
     * @param executionContext Execution context
     * @param signal AbortSignal for request cancellation
     * @returns AIResponseChunk containing normalized image analysis chunks
     */
    analyzeImageStream(
        req: AIRequest<ClientImageAnalysisRequest>,
        executionContext: MultiModalExecutionContext,
        signal?: AbortSignal
    ): AsyncGenerator<AIResponseChunk<NormalizedImageAnalysis[]>> {
        if (!this.imageAnalysisDelegate || typeof this.imageAnalysisDelegate.analyzeImageStream !== "function") {
            throw new CapabilityUnsupportedError(this.providerType, CapabilityKeys.ImageAnalysisStreamCapabilityKey);
        }
        return this.imageAnalysisDelegate.analyzeImageStream(req, executionContext, signal);
    }
}
