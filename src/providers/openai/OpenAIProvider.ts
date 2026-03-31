/**
 * @module providers/openai/OpenAIProvider.ts
 * @description Provider implementations and capability adapters.
 */
import OpenAI from "openai";
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
    ClientAudioTranscriptionRequest,
    ClientAudioTranslationRequest,
    ClientTextToSpeechRequest,
    CapabilityUnsupportedError,
    ChatCapability,
    ChatStreamCapability,
    ClientChatRequest,
    ClientEmbeddingRequest,
    ClientImageAnalysisRequest,
    ClientImageEditRequest,
    ClientImageGenerationRequest,
    ClientOCRRequest,
    ClientVideoDownloadRequest,
    ClientVideoGenerationRequest,
    ClientVideoRemixRequest,
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
    NormalizedAudio,
    NormalizedEmbedding,
    NormalizedImage,
    NormalizedImageAnalysis,
    NormalizedModeration,
    NormalizedOCRDocument,
    NormalizedVideo,
    OpenAIChatCapabilityImpl,
    OpenAIEmbedCapabilityImpl,
    OpenAIAudioTextToSpeechCapabilityImpl,
    OpenAIAudioTranscriptionCapabilityImpl,
    OpenAIAudioTranslationCapabilityImpl,
    OpenAIImageAnalysisCapabilityImpl,
    OpenAIImageEditCapabilityImpl,
    OpenAIImageGenerationCapabilityImpl,
    OpenAIOCRCapabilityImpl,
    OpenAIModerationCapabilityImpl,
    OpenAIVideoDownloadCapabilityImpl,
    OpenAIVideoGenerationCapabilityImpl,
    OpenAIVideoRemixCapabilityImpl,
    OCRCapability,
    TextToSpeechCapability,
    TextToSpeechStreamCapability,
    VideoGenerationCapability,
    VideoDownloadCapability,
    VideoRemixCapability,
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
/**
 * @public
 * @description Provider capability implementation for OpenAIProvider.
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
        VideoGenerationCapability<ClientVideoGenerationRequest>,
        VideoDownloadCapability<ClientVideoDownloadRequest>,
        VideoRemixCapability<ClientVideoRemixRequest>,
        ImageEditCapability<ClientImageEditRequest>,
        ImageEditStreamCapability<ClientImageEditRequest>,
        AudioTranscriptionCapability<ClientAudioTranscriptionRequest>,
        AudioTranscriptionStreamCapability<ClientAudioTranscriptionRequest>,
        AudioTranslationCapability<ClientAudioTranslationRequest>,
        OCRCapability<ClientOCRRequest>,
        TextToSpeechCapability<ClientTextToSpeechRequest>,
        TextToSpeechStreamCapability<ClientTextToSpeechRequest>
{
    /**
     * Underlying OpenAI SDK client
     */
    private client: OpenAI | null = null;
    /**
     * Capability delegate implementations
     */
    private chatDelegate: OpenAIChatCapabilityImpl | null = null;
    private embedDelegate: OpenAIEmbedCapabilityImpl | null = null;
    private moderateDelegate: OpenAIModerationCapabilityImpl | null = null;
    private imageEditDelegate: OpenAIImageEditCapabilityImpl | null = null;
    private imageGenDelegate: OpenAIImageGenerationCapabilityImpl | null = null;
    private imageAnalysisDelegate: OpenAIImageAnalysisCapabilityImpl | null = null;
    private ocrDelegate: OpenAIOCRCapabilityImpl | null = null;
    private audioTranscriptionDelegate: OpenAIAudioTranscriptionCapabilityImpl | null = null;
    private audioTranslationDelegate: OpenAIAudioTranslationCapabilityImpl | null = null;
    private audioTtsDelegate: OpenAIAudioTextToSpeechCapabilityImpl | null = null;
    private videoDelegate: OpenAIVideoGenerationCapabilityImpl | null = null;
    private videoDownloadDelegate: OpenAIVideoDownloadCapabilityImpl | null = null;
    private videoRemixDelegate: OpenAIVideoRemixCapabilityImpl | null = null;

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
        this.ocrDelegate = new OpenAIOCRCapabilityImpl(this, this.client);
        this.audioTranscriptionDelegate = new OpenAIAudioTranscriptionCapabilityImpl(this, this.client);
        this.audioTranslationDelegate = new OpenAIAudioTranslationCapabilityImpl(this, this.client);
        this.audioTtsDelegate = new OpenAIAudioTextToSpeechCapabilityImpl(this, this.client);
        this.videoDelegate = new OpenAIVideoGenerationCapabilityImpl(this, this.client);
        this.videoDownloadDelegate = new OpenAIVideoDownloadCapabilityImpl(this, this.client);
        this.videoRemixDelegate = new OpenAIVideoRemixCapabilityImpl(this, this.client);

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
        this.registerCapability(
            CapabilityKeys.OCRCapabilityKey,
            this as OCRCapability<ClientOCRRequest, NormalizedOCRDocument[]>
        );
        this.registerCapability(
            CapabilityKeys.VideoGenerationCapabilityKey,
            this as VideoGenerationCapability<ClientVideoGenerationRequest, NormalizedVideo[]>
        );
        this.registerCapability(
            CapabilityKeys.VideoDownloadCapabilityKey,
            this as VideoDownloadCapability<ClientVideoDownloadRequest, NormalizedVideo[]>
        );
        this.registerCapability(
            CapabilityKeys.VideoRemixCapabilityKey,
            this as VideoRemixCapability<ClientVideoRemixRequest, NormalizedVideo[]>
        );
        this.registerCapability(
            CapabilityKeys.AudioTranscriptionCapabilityKey,
            this as AudioTranscriptionCapability<ClientAudioTranscriptionRequest, NormalizedChatMessage[]>
        );
        this.registerCapability(
            CapabilityKeys.AudioTranscriptionStreamCapabilityKey,
            this as AudioTranscriptionStreamCapability<ClientAudioTranscriptionRequest, NormalizedChatMessage[]>
        );
        this.registerCapability(
            CapabilityKeys.AudioTranslationCapabilityKey,
            this as AudioTranslationCapability<ClientAudioTranslationRequest, NormalizedChatMessage[]>
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
     * @param request - Unified AI request containing image edit input
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

    /**
     * Execute a non-streaming OCR request.
     *
     * @param req Unified AI request containing OCR input and options.
     * @param executionContext Execution context.
     * @param signal AbortSignal for request cancellation.
     * @returns AIResponse containing normalized OCR document artifacts.
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

    /**
     * Execute a non-streaming video generation request.
     *
     * @param req Unified AI request containing prompt and optional generation params.
     * @param executionContext Execution context.
     * @param signal AbortSignal for cancellation.
     * @returns AIResponse containing normalized generated video artifact(s).
     */
    async generateVideo(
        req: AIRequest<ClientVideoGenerationRequest>,
        executionContext: MultiModalExecutionContext,
        signal?: AbortSignal
    ): Promise<AIResponse<NormalizedVideo[]>> {
        if (!this.videoDelegate || typeof this.videoDelegate.generateVideo !== "function") {
            throw new CapabilityUnsupportedError(this.providerType, CapabilityKeys.VideoGenerationCapabilityKey);
        }
        return await this.videoDelegate.generateVideo(req, executionContext, signal);
    }

    /**
     * Execute a non-streaming video download request.
     *
     * @param req Unified AI request containing video id and optional variant.
     * @param executionContext Execution context.
     * @param signal AbortSignal for cancellation.
     * @returns AIResponse containing normalized downloaded video artifact(s).
     */
    async downloadVideo(
        req: AIRequest<ClientVideoDownloadRequest>,
        executionContext: MultiModalExecutionContext,
        signal?: AbortSignal
    ): Promise<AIResponse<NormalizedVideo[]>> {
        if (!this.videoDownloadDelegate || typeof this.videoDownloadDelegate.downloadVideo !== "function") {
            throw new CapabilityUnsupportedError(this.providerType, CapabilityKeys.VideoDownloadCapabilityKey);
        }
        return await this.videoDownloadDelegate.downloadVideo(req, executionContext, signal);
    }

    /**
     * Execute a non-streaming video remix request.
     *
     * @param req Unified AI request containing source video id and remix prompt.
     * @param executionContext Execution context.
     * @param signal AbortSignal for cancellation.
     * @returns AIResponse containing normalized remixed video artifact(s).
     */
    async remixVideo(
        req: AIRequest<ClientVideoRemixRequest>,
        executionContext: MultiModalExecutionContext,
        signal?: AbortSignal
    ): Promise<AIResponse<NormalizedVideo[]>> {
        if (!this.videoRemixDelegate || typeof this.videoRemixDelegate.remixVideo !== "function") {
            throw new CapabilityUnsupportedError(this.providerType, CapabilityKeys.VideoRemixCapabilityKey);
        }
        return await this.videoRemixDelegate.remixVideo(req, executionContext, signal);
    }

    /**
     * Execute a non-streaming audio transcription request.
     *
     * @param req Unified AI request containing audio input and optional transcription params.
     * @param executionContext Execution context.
     * @param signal AbortSignal for cancellation.
     * @returns AIResponse containing normalized transcription artifact(s).
     */
    async transcribeAudio(
        req: AIRequest<ClientAudioTranscriptionRequest>,
        executionContext: MultiModalExecutionContext,
        signal?: AbortSignal
    ): Promise<AIResponse<NormalizedChatMessage[]>> {
        if (!this.audioTranscriptionDelegate || typeof this.audioTranscriptionDelegate.transcribeAudio !== "function") {
            throw new CapabilityUnsupportedError(this.providerType, CapabilityKeys.AudioTranscriptionCapabilityKey);
        }
        return await this.audioTranscriptionDelegate.transcribeAudio(req, executionContext, signal);
    }

    /**
     * Execute a streaming audio transcription request.
     *
     * @param req Unified AI request containing audio input and optional transcription params.
     * @param executionContext Execution context.
     * @param signal AbortSignal for cancellation.
     * @returns Async iterable emitting incremental transcription chunks.
     */
    transcribeAudioStream(
        req: AIRequest<ClientAudioTranscriptionRequest>,
        executionContext: MultiModalExecutionContext,
        signal?: AbortSignal
    ): AsyncGenerator<AIResponseChunk<NormalizedChatMessage[]>> {
        if (!this.audioTranscriptionDelegate || typeof this.audioTranscriptionDelegate.transcribeAudioStream !== "function") {
            throw new CapabilityUnsupportedError(this.providerType, CapabilityKeys.AudioTranscriptionStreamCapabilityKey);
        }
        return this.audioTranscriptionDelegate.transcribeAudioStream(req, executionContext, signal);
    }

    /**
     * Execute a non-streaming audio translation request.
     *
     * @param req Unified AI request containing source audio and translation options.
     * @param executionContext Execution context.
     * @param signal AbortSignal for cancellation.
     * @returns AIResponse containing normalized translated transcript artifact(s).
     */
    async translateAudio(
        req: AIRequest<ClientAudioTranslationRequest>,
        executionContext: MultiModalExecutionContext,
        signal?: AbortSignal
    ): Promise<AIResponse<NormalizedChatMessage[]>> {
        if (!this.audioTranslationDelegate || typeof this.audioTranslationDelegate.translateAudio !== "function") {
            throw new CapabilityUnsupportedError(this.providerType, CapabilityKeys.AudioTranslationCapabilityKey);
        }
        return await this.audioTranslationDelegate.translateAudio(req, executionContext, signal);
    }

    /**
     * Execute a non-streaming text-to-speech request.
     *
     * @param req Unified AI request containing input text and TTS options.
     * @param executionContext Execution context.
     * @param signal AbortSignal for cancellation.
     * @returns AIResponse containing normalized synthesized audio artifact(s).
     */
    async textToSpeech(
        req: AIRequest<ClientTextToSpeechRequest>,
        executionContext: MultiModalExecutionContext,
        signal?: AbortSignal
    ): Promise<AIResponse<NormalizedAudio[]>> {
        if (!this.audioTtsDelegate || typeof this.audioTtsDelegate.textToSpeech !== "function") {
            throw new CapabilityUnsupportedError(this.providerType, CapabilityKeys.AudioTextToSpeechCapabilityKey);
        }
        return await this.audioTtsDelegate.textToSpeech(req, executionContext, signal);
    }

    /**
     * Execute a streaming text-to-speech request.
     *
     * @param req Unified AI request containing input text and TTS options.
     * @param executionContext Execution context.
     * @param signal AbortSignal for cancellation.
     * @returns Async iterable emitting incremental synthesized audio chunks.
     */
    textToSpeechStream(
        req: AIRequest<ClientTextToSpeechRequest>,
        executionContext: MultiModalExecutionContext,
        signal?: AbortSignal
    ): AsyncGenerator<AIResponseChunk<NormalizedAudio[]>> {
        if (!this.audioTtsDelegate || typeof this.audioTtsDelegate.textToSpeechStream !== "function") {
            throw new CapabilityUnsupportedError(this.providerType, CapabilityKeys.AudioTextToSpeechStreamCapabilityKey);
        }
        return this.audioTtsDelegate.textToSpeechStream(req, executionContext, signal);
    }
}
