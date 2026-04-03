/**
 * @module providers/anthropic/AnthropicProvider.ts
 * @description Provider implementations and capability adapters.
 */
import Anthropic from "@anthropic-ai/sdk";
import {
    AIProvider,
    AIRequest,
    AIResponse,
    AIResponseChunk,
    AnthropicChatCapabilityImpl,
    AnthropicEmbedCapabilityImpl,
    AnthropicImageAnalysisCapabilityImpl,
    AnthropicOCRCapabilityImpl,
    AnthropicModerationCapabilityImpl,
    BaseProvider,
    CapabilityKeys,
    CapabilityUnsupportedError,
    ChatCapability,
    ChatStreamCapability,
    ClientChatRequest,
    ClientEmbeddingRequest,
    ClientImageAnalysisRequest,
    ClientModerationRequest,
    ClientOCRRequest,
    EmbedCapability,
    ImageAnalysisCapability,
    ImageAnalysisStreamCapability,
    ModerationCapability,
    MultiModalExecutionContext,
    NormalizedChatMessage,
    NormalizedEmbedding,
    NormalizedImageAnalysis,
    NormalizedModeration,
    NormalizedOCRDocument,
    OCRCapability,
    ProviderConnectionConfig
} from "#root/index.js";

/**
 * AnthropicProvider: Concrete BaseProvider implementation for the Anthropic API.
 *
 * Responsibilities:
 * - Owns the Anthropic SDK client
 * - Initializes provider-level configuration
 * - Registers supported capabilities
 * - Delegates capability execution to specialized implementations
 *
 * Implements chat, embedding, and moderation capabilities for Anthropic.
 *
 * @template TChatInput - Input type for chat requests
 * @template TEmbedInput - Input type for embedding requests
 * @template TModerationInput - Input type for moderation requests
 */
export class AnthropicProvider
    extends BaseProvider
    implements
        ChatCapability<ClientChatRequest>,
        ChatStreamCapability<ClientChatRequest>,
        EmbedCapability<ClientEmbeddingRequest>,
        ModerationCapability<ClientModerationRequest>,
        ImageAnalysisCapability<ClientImageAnalysisRequest>,
        ImageAnalysisStreamCapability<ClientImageAnalysisRequest>,
        OCRCapability<ClientOCRRequest>
{
    /**
     * Underlying Anthropic SDK client instance
     */
    private client: Anthropic | null = null;
    /**
     * Capability delegate implementations
     */
    private chatDelegate: AnthropicChatCapabilityImpl | null = null;
    private moderateDelegate: AnthropicModerationCapabilityImpl | null = null;
    private embedDelegate: AnthropicEmbedCapabilityImpl | null = null;
    private imageAnalysisDelegate: AnthropicImageAnalysisCapabilityImpl | null = null;
    private ocrDelegate: AnthropicOCRCapabilityImpl | null = null;
    public constructor() {
        super(AIProvider.Anthropic);
    }

    /**
     * Initializes the Anthropic provider.
     *
     * @param config - Connection configuration for the provider
     * @throws Error if the API key is missing or invalid
     */
    override init(config: ProviderConnectionConfig) {
        // Initialization logic for Anthropic provider`
        if (!config.apiKey) {
            throw new Error(`Anthropic API key ${config.apiKeyEnvVar} required but not found in config. Check .env file`);
        }
        this.config = config;
        this.client = new Anthropic({
            apiKey: config.apiKey,
            ...BaseProvider.sanitizeConstructorParams(config.providerDefaults?.providerParams ?? {})
        });

        // Initialize capability delegates
        this.chatDelegate = new AnthropicChatCapabilityImpl(this, this.client);
        this.moderateDelegate = new AnthropicModerationCapabilityImpl(this, this.client);
        this.embedDelegate = new AnthropicEmbedCapabilityImpl(this);
        this.imageAnalysisDelegate = new AnthropicImageAnalysisCapabilityImpl(this, this.client);
        this.ocrDelegate = new AnthropicOCRCapabilityImpl(this, this.client);

        // Register supported capabilities
        this.registerCapability(
            CapabilityKeys.ChatCapabilityKey,
            this as ChatCapability<ClientChatRequest, NormalizedChatMessage>
        );
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
            CapabilityKeys.ImageAnalysisCapabilityKey,
            this as ImageAnalysisCapability<ClientImageAnalysisRequest, NormalizedImageAnalysis[]>
        );
        this.registerCapability(
            CapabilityKeys.ImageAnalysisStreamCapabilityKey,
            this as ImageAnalysisStreamCapability<ClientImageAnalysisRequest, NormalizedImageAnalysis[]>
        );
        this.registerCapability(
            CapabilityKeys.OCRCapabilityKey,
            this as OCRCapability<ClientOCRRequest, NormalizedOCRDocument[]>
        );
    }

    /**
     * Execute a non-streaming chat request.
     *
     * @template TChatInput Chat request type
     * @param req - Unified AI request containing chat input and options
     * @param signal AbortSignal for request cancellation
     * @param executionContext Execution context
     * @returns AIResponse containing generated text output
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
     * @template TChatInput Chat request type
     * @param req - Unified AI request containing chat input and options
     * @param executionContext Execution context
     * @param signal AbortSignal for request cancellation
     * @returns AsyncGenerator emitting streamed response chunks
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
     * Execute a moderation request.
     *
     * @template TModerationInput Moderation request type
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
     * Execute an embedding request.
     *
     * @template TEmbedInput Embedding request type
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

    /**
     * Execute a non-streaming OCR request.
     */
    async ocr(
        req: AIRequest<ClientOCRRequest>,
        executionContext: MultiModalExecutionContext,
        signal?: AbortSignal
    ): Promise<AIResponse<NormalizedOCRDocument[]>> {
        if (!this.ocrDelegate || typeof this.ocrDelegate.ocr !== "function") {
            throw new CapabilityUnsupportedError(this.providerType, CapabilityKeys.OCRCapabilityKey);
        }
        return await this.ocrDelegate.ocr(req, executionContext, signal);
    }
}
