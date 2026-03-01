import { GoogleGenAI } from "@google/genai";
import {
    AIProvider,
    AIRequest,
    AIResponse,
    AIResponseChunk,
    AudioTranscriptionCapability,
    AudioTranscriptionStreamCapability,
    AudioTranslationCapability,
    BaseProvider,
    CapabilityKeys,
    CapabilityUnsupportedError,
    ChatCapability,
    ChatStreamCapability,
    ClientAudioTranscriptionRequest,
    ClientAudioTranslationRequest,
    ClientTextToSpeechRequest,
    ClientChatRequest,
    ClientEmbeddingRequest,
    ClientImageAnalysisRequest,
    ClientImageGenerationRequest,
    ClientModerationRequest,
    EmbedCapability,
    GeminiAudioCapabilityImpl,
    GeminiChatCapabilityImpl,
    GeminiEmbedCapabilityImpl,
    GeminiImageAnalysisCapabilityImpl,
    GeminiImageGenerationCapabilityImpl,
    GeminiModerationCapabilityImpl,
    ImageAnalysisCapability,
    ImageAnalysisStreamCapability,
    ImageGenerationCapability,
    ImageGenerationStreamCapability,
    ModerationCapability,
    MultiModalExecutionContext,
    NormalizedAudio,
    NormalizedChatMessage,
    NormalizedEmbedding,
    NormalizedImage,
    NormalizedImageAnalysis,
    NormalizedModeration,
    ProviderConnectionConfig,
    TextToSpeechCapability,
    TextToSpeechStreamCapability
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
        ImageGenerationStreamCapability<ClientImageGenerationRequest>,
        ImageAnalysisCapability<ClientImageAnalysisRequest>,
        ImageAnalysisStreamCapability<ClientImageAnalysisRequest>,
        AudioTranscriptionCapability<ClientAudioTranscriptionRequest>,
        AudioTranscriptionStreamCapability<ClientAudioTranscriptionRequest>,
        AudioTranslationCapability<ClientAudioTranslationRequest>,
        TextToSpeechCapability<ClientTextToSpeechRequest>,
        TextToSpeechStreamCapability<ClientTextToSpeechRequest>
{
    /** Underlying Google Gemini SDK client */
    private client: GoogleGenAI | null = null;

    /** Capability delegate implementations */
    private chatDelegate: GeminiChatCapabilityImpl | null = null;
    private imageGenerationDelegate: GeminiImageGenerationCapabilityImpl | null = null;
    private imageAnalysisDelegate: GeminiImageAnalysisCapabilityImpl | null = null;
    private moderationDelegate: GeminiModerationCapabilityImpl | null = null;
    private embedDelegate: GeminiEmbedCapabilityImpl | null = null;
    private audioDelegate: GeminiAudioCapabilityImpl | null = null;

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
        this.audioDelegate = new GeminiAudioCapabilityImpl(this, this.client);

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
            CapabilityKeys.ImageGenerationCapabilityKey,
            this as ImageGenerationCapability<ClientImageGenerationRequest, NormalizedImage[]>
        );
        this.registerCapability(
            CapabilityKeys.ImageGenerationStreamCapabilityKey,
            this as ImageGenerationStreamCapability<ClientImageGenerationRequest, NormalizedImage[]>
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
            CapabilityKeys.AudioTranscriptionCapabilityKey,
            this as AudioTranscriptionCapability<ClientAudioTranscriptionRequest, NormalizedAudio[]>
        );
        this.registerCapability(
            CapabilityKeys.AudioTranscriptionStreamCapabilityKey,
            this as AudioTranscriptionStreamCapability<ClientAudioTranscriptionRequest, NormalizedAudio[]>
        );
        this.registerCapability(
            CapabilityKeys.AudioTranslationCapabilityKey,
            this as AudioTranslationCapability<ClientAudioTranslationRequest, NormalizedAudio[]>
        );
        this.registerCapability(
            CapabilityKeys.AudioTextToSpeechCapabilityKey,
            this as TextToSpeechCapability<ClientTextToSpeechRequest, NormalizedAudio[]>
        );
        this.registerCapability(
            CapabilityKeys.AudioTextToSpeechStreamCapabilityKey,
            this as TextToSpeechStreamCapability<ClientTextToSpeechRequest, NormalizedAudio[]>
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
        if (!this.moderationDelegate || typeof this.moderationDelegate.moderation !== "function") {
            throw new CapabilityUnsupportedError(this.providerType, CapabilityKeys.ModerationCapabilityKey);
        }
        return await this.moderationDelegate.moderation(req, executionContext, signal);
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
     * Execute an image generation request.
     *
     * @template TImageInput Image input type
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
        if (!this.imageGenerationDelegate || typeof this.imageGenerationDelegate.generateImage !== "function") {
            throw new CapabilityUnsupportedError(this.providerType, CapabilityKeys.ImageGenerationCapabilityKey);
        }
        return await this.imageGenerationDelegate.generateImage(req, executionContext, signal);
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
        if (!this.imageGenerationDelegate || typeof this.imageGenerationDelegate.generateImageStream !== "function") {
            throw new CapabilityUnsupportedError(this.providerType, CapabilityKeys.ImageGenerationStreamCapabilityKey);
        }
        return this.imageGenerationDelegate.generateImageStream(req, executionContext, signal);
    }

    /**
     * Execute an image analysis request
     *
     * @template TImageAnalysisInput Image analysis input type
     * @param req - Unified AI request containing Image analysis input and options
     * @param executionContext Execution context
     * @param signal AbortSignal for request cancellation
     * @returns AIResponse containing normalized image analysis results
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
     * Execute a streaming image analysis request.
     *
     * @template TImageAnalysisInput Image analysis input type
     * @param req - Unified AI request containing image analysis input and options
     * @param executionContext Execution context
     * @param signal AbortSignal for request cancellation
     * @returns Async iterable emitting streamed response chunks
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
     * Execute a non-streaming audio transcription request.
     *
     * @param req Unified AI request containing audio input and transcription options.
     * @param executionContext Execution context.
     * @param signal AbortSignal for request cancellation.
     * @returns AIResponse containing normalized transcription artifact(s).
     */
    async transcribeAudio(
        req: AIRequest<ClientAudioTranscriptionRequest>,
        executionContext: MultiModalExecutionContext,
        signal?: AbortSignal
    ): Promise<AIResponse<NormalizedAudio[]>> {
        if (!this.audioDelegate || typeof this.audioDelegate.transcribeAudio !== "function") {
            throw new CapabilityUnsupportedError(this.providerType, CapabilityKeys.AudioTranscriptionCapabilityKey);
        }
        return await this.audioDelegate.transcribeAudio(req, executionContext, signal);
    }

    /**
     * Execute a streaming audio transcription request.
     *
     * @param req Unified AI request containing audio input and transcription options.
     * @param executionContext Execution context.
     * @param signal AbortSignal for request cancellation.
     * @returns Async iterable emitting incremental transcription chunks.
     */
    transcribeAudioStream(
        req: AIRequest<ClientAudioTranscriptionRequest>,
        executionContext: MultiModalExecutionContext,
        signal?: AbortSignal
    ): AsyncGenerator<AIResponseChunk<NormalizedAudio[]>> {
        if (!this.audioDelegate || typeof this.audioDelegate.transcribeAudioStream !== "function") {
            throw new CapabilityUnsupportedError(this.providerType, CapabilityKeys.AudioTranscriptionStreamCapabilityKey);
        }
        return this.audioDelegate.transcribeAudioStream(req, executionContext, signal);
    }

    /**
     * Execute a non-streaming audio translation request.
     *
     * @param req Unified AI request containing source audio and translation options.
     * @param executionContext Execution context.
     * @param signal AbortSignal for request cancellation.
     * @returns AIResponse containing normalized translated transcript artifact(s).
     */
    async translateAudio(
        req: AIRequest<ClientAudioTranslationRequest>,
        executionContext: MultiModalExecutionContext,
        signal?: AbortSignal
    ): Promise<AIResponse<NormalizedAudio[]>> {
        if (!this.audioDelegate || typeof this.audioDelegate.translateAudio !== "function") {
            throw new CapabilityUnsupportedError(this.providerType, CapabilityKeys.AudioTranslationCapabilityKey);
        }
        return await this.audioDelegate.translateAudio(req, executionContext, signal);
    }

    /**
     * Execute a non-streaming text-to-speech request.
     *
     * @param req Unified AI request containing input text and TTS options.
     * @param executionContext Execution context.
     * @param signal AbortSignal for request cancellation.
     * @returns AIResponse containing normalized synthesized audio artifact(s).
     */
    async textToSpeech(
        req: AIRequest<ClientTextToSpeechRequest>,
        executionContext: MultiModalExecutionContext,
        signal?: AbortSignal
    ): Promise<AIResponse<NormalizedAudio[]>> {
        if (!this.audioDelegate || typeof this.audioDelegate.textToSpeech !== "function") {
            throw new CapabilityUnsupportedError(this.providerType, CapabilityKeys.AudioTextToSpeechCapabilityKey);
        }
        return await this.audioDelegate.textToSpeech(req, executionContext, signal);
    }

    /**
     * Execute a streaming text-to-speech request.
     *
     * @param req Unified AI request containing input text and TTS options.
     * @param executionContext Execution context.
     * @param signal AbortSignal for request cancellation.
     * @returns Async iterable emitting incremental synthesized audio chunks.
     */
    textToSpeechStream(
        req: AIRequest<ClientTextToSpeechRequest>,
        executionContext: MultiModalExecutionContext,
        signal?: AbortSignal
    ): AsyncGenerator<AIResponseChunk<NormalizedAudio[]>> {
        if (!this.audioDelegate || typeof this.audioDelegate.textToSpeechStream !== "function") {
            throw new CapabilityUnsupportedError(this.providerType, CapabilityKeys.AudioTextToSpeechStreamCapabilityKey);
        }
        return this.audioDelegate.textToSpeechStream(req, executionContext, signal);
    }
}
