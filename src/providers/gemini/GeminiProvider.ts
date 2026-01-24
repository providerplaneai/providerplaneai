import { GoogleGenAI } from "@google/genai";
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
    ClientImageGenerationRequest,
    ClientModerationRequest,
    EmbedCapability,
    GeminiChatCapabilityImpl,
    GeminiEmbedCapabilityImpl,
    GeminiImageAnalysisCapabilityImpl,
    GeminiImageGenerationCapabilityImpl,
    GeminiModerationCapabilityImpl,
    ImageAnalysisCapability,
    ImageGenerationCapability,
    ModerationCapability,
    ModerationResult,
    MultiModalExecutionContext,
    NormalizedImage,
    NormalizedImageAnalysis,
    ProviderConnectionConfig
} from "#root/index.js";

/**
 * GeminiProvider: Concrete BaseProvider implementation for Google Gemini models.
 *
 * Responsibilities:
 * - Owns the GoogleGenAI SDK client
 * - Initializes provider-level configuration
 * - Registers supported capabilities
 * - Delegates execution to capability-specific implementations
 *
 * Implements chat, embedding, image, and moderation capabilities for Gemini.
 *
 * @template TChatInput - Input type for chat requests
 * @template TEmbedInput - Input type for embedding requests
 * @template TImageInput - Input type for image generation requests
 * @template TModerationInput - Input type for moderation requests
 */
export class GeminiProvider
    extends BaseProvider
    implements
        ChatCapability<ClientChatRequest>,
        ChatStreamCapability<ClientChatRequest>,
        ModerationCapability<ClientModerationRequest>,
        EmbedCapability<ClientEmbeddingRequest>,
        ImageGenerationCapability<ClientImageGenerationRequest>,
        ImageAnalysisCapability<ClientImageAnalysisRequest>
{
    /** Underlying Google Gemini SDK client */
    private client: GoogleGenAI | null = null;

    /** Capability delegate implementations */
    private chatDelegate: GeminiChatCapabilityImpl | null = null;
    private imageGenerationDelegate: GeminiImageGenerationCapabilityImpl | null = null;
    private imageAnalysisDelegate: GeminiImageAnalysisCapabilityImpl | null = null;
    private moderationDelegate: GeminiModerationCapabilityImpl | null = null;
    private embedDelegate: GeminiEmbedCapabilityImpl | null = null;

    public constructor() {
        super(AIProvider.Gemini);
    }

    /**
     * Initializes the Gemini provider and registers supported capabilities.
     *
     * @param config - Provider connection configuration
     * @throws Error if API key is missing or invalid
     */
    override init(config: ProviderConnectionConfig) {
        console.log(`Initializing Gemini Provider`);

        // Initialization logic for Gemini provider`
        if (!config.apiKey) {
            throw new Error(`Gemini API key ${config.apiKeyEnvVar} required but not found in config. Check .env file`);
        }

        this.config = config;
        this.client = new GoogleGenAI({
            apiKey: config.apiKey,
            ...(config.providerDefaults?.providerParams ?? {})
        });

        // Initialize capability delegates
        this.chatDelegate = new GeminiChatCapabilityImpl(this, this.client);
        this.moderationDelegate = new GeminiModerationCapabilityImpl(this, this.client);
        this.embedDelegate = new GeminiEmbedCapabilityImpl(this, this.client);
        this.imageGenerationDelegate = new GeminiImageGenerationCapabilityImpl(this, this.client);
        this.imageAnalysisDelegate = new GeminiImageAnalysisCapabilityImpl(this, this.client);

        // Register supported capabilities
        this.registerCapability(CapabilityKeys.ChatCapabilityKey, this as ChatCapability<ClientChatRequest, string>);
        this.registerCapability(
            CapabilityKeys.ChatStreamCapabilityKey,
            this as ChatStreamCapability<ClientChatRequest, string>
        );
        this.registerCapability(
            CapabilityKeys.EmbedCapabilityKey,
            this as EmbedCapability<ClientEmbeddingRequest, number[] | number[][]>
        );
        this.registerCapability(
            CapabilityKeys.ModerationCapabilityKey,
            this as ModerationCapability<ClientModerationRequest, ModerationResult | ModerationResult[]>
        );
        this.registerCapability(
            CapabilityKeys.ImageGenerationCapabilityKey,
            this as ImageGenerationCapability<ClientImageGenerationRequest, NormalizedImage[]>
        );
        this.registerCapability(
            CapabilityKeys.ImageAnalysisCapabilityKey,
            this as ImageAnalysisCapability<ClientImageAnalysisRequest, NormalizedImageAnalysis[]>
        );
    }

    /**
     * Execute a non-streaming chat request.
     *
     * @template TChatInput Chat input type
     * @param req - Unified AI request containing chat input and options
     * @param executionContext Execution context
     * @returns AIResponse containing generated text
     */
    async chat(req: AIRequest<ClientChatRequest>, executionContext: MultiModalExecutionContext): Promise<AIResponse<string>> {
        if (!this.chatDelegate || typeof this.chatDelegate.chat !== "function") {
            throw new CapabilityUnsupportedError(this.providerType, CapabilityKeys.ChatCapabilityKey);
        }
        return await this.chatDelegate.chat(req, executionContext);
    }

    /**
     * Execute a streaming chat request.
     *
     * @template TChatInput Chat input type
     * @param req - Unified AI request containing chat input and options
     * @param executionContext Execution context
     * @returns Async iterable emitting streamed response chunks
     */
    chatStream(
        req: AIRequest<ClientChatRequest>,
        executionContext: MultiModalExecutionContext
    ): AsyncGenerator<AIResponseChunk<string>> {
        if (!this.chatDelegate || typeof this.chatDelegate.chatStream !== "function") {
            throw new CapabilityUnsupportedError(this.providerType, CapabilityKeys.ChatStreamCapabilityKey);
        }
        return this.chatDelegate.chatStream(req, executionContext);
    }

    /**
     * Execute a moderation request.
     *
     * @template TModerationInput Moderation input type
     * @param req - Unified AI request containing moderation input
     * @param executionContext Execution context
     * @returns AIResponse containing moderation result(s)
     */
    async moderation(
        req: AIRequest<ClientModerationRequest>,
        executionContext: MultiModalExecutionContext
    ): Promise<AIResponse<ModerationResult | ModerationResult[]>> {
        if (!this.moderationDelegate || typeof this.moderationDelegate.moderation !== "function") {
            throw new CapabilityUnsupportedError(this.providerType, CapabilityKeys.ModerationCapabilityKey);
        }
        return await this.moderationDelegate.moderation(req, executionContext);
    }

    /**
     * Execute an embedding request.
     *
     * @template TEmbedInput Embedding input type
     * @param req - Unified AI request containing embedding input
     * @param executionContext Execution context
     * @returns AIResponse containing embedding vector(s)
     */
    async embed(
        req: AIRequest<ClientEmbeddingRequest>,
        executionContext: MultiModalExecutionContext
    ): Promise<AIResponse<number[] | number[][]>> {
        if (!this.embedDelegate || typeof this.embedDelegate.embed !== "function") {
            throw new CapabilityUnsupportedError(this.providerType, CapabilityKeys.EmbedCapabilityKey);
        }
        return await this.embedDelegate.embed(req, executionContext);
    }

    /**
     * Execute an image generation request.
     *
     * @template TImageInput Image input type
     * @param req - Unified AI request containing image generation input
     * @param executionContext Execution context
     * @returns AIResponse containing normalized generated images
     */
    async generateImage(
        req: AIRequest<ClientImageGenerationRequest>,
        executionContext: MultiModalExecutionContext
    ): Promise<AIResponse<NormalizedImage[]>> {
        if (!this.imageGenerationDelegate || typeof this.imageGenerationDelegate.generateImage !== "function") {
            throw new CapabilityUnsupportedError(this.providerType, CapabilityKeys.ImageGenerationCapabilityKey);
        }
        return await this.imageGenerationDelegate.generateImage(req, executionContext);
    }

    /**
     * Execute an image analysis request
     *
     * @template TImageAnalysisInput Image analysis input type
     * @param req - Unified AI request containing Image analysis input and options
     * @param executionContext Execution context
     * @returns AIResponse containing normalized image analysis
     */
    async analyzeImage(
        req: AIRequest<ClientImageAnalysisRequest>,
        executionContext: MultiModalExecutionContext
    ): Promise<AIResponse<NormalizedImageAnalysis[]>> {
        if (!this.imageAnalysisDelegate || typeof this.imageAnalysisDelegate.analyzeImage !== "function") {
            throw new CapabilityUnsupportedError(this.providerType, CapabilityKeys.ImageAnalysisCapabilityKey);
        }
        return await this.imageAnalysisDelegate.analyzeImage(req, executionContext);
    }
}
