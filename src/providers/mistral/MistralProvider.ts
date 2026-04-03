/**
 * @module providers/mistral/MistralProvider.ts
 * @description Provider implementation and capability adapters for Mistral.
 */
import { Mistral } from "@mistralai/mistralai";
import {
    AIProvider,
    AIRequest,
    AIResponse,
    AIResponseChunk,
    AudioTranscriptionCapability,
    AudioTranscriptionStreamCapability,
    BaseProvider,
    CapabilityKeys,
    CapabilityUnsupportedError,
    ClientAudioTranscriptionRequest,
    ChatCapability,
    ChatStreamCapability,
    ClientChatRequest,
    ClientEmbeddingRequest,
    ClientImageAnalysisRequest,
    ClientOCRRequest,
    ClientTextToSpeechRequest,
    ClientModerationRequest,
    EmbedCapability,
    ImageAnalysisCapability,
    ImageAnalysisStreamCapability,
    MistralAudioTextToSpeechCapabilityImpl,
    MistralAudioTranscriptionCapabilityImpl,
    MistralChatCapabilityImpl,
    MistralEmbedCapabilityImpl,
    MistralImageAnalysisCapabilityImpl,
    MistralModerationCapabilityImpl,
    MistralOCRCapabilityImpl,
    ModerationCapability,
    MultiModalExecutionContext,
    NormalizedAudio,
    NormalizedChatMessage,
    NormalizedEmbedding,
    NormalizedImageAnalysis,
    NormalizedOCRDocument,
    NormalizedModeration,
    ProviderConnectionConfig,
    OCRCapability,
    TextToSpeechCapability,
    TextToSpeechStreamCapability
} from "#root/index.js";

/**
 * MistralProvider: concrete BaseProvider implementation for Mistral AI.
 *
 * Responsibilities:
 * - Own the official Mistral SDK client
 * - Register supported Mistral v1 capabilities
 * - Delegate capability execution to capability-specific adapters
 *
 * Supported v1 capabilities:
 * - chat
 * - chatStream
 * - embed
 * - moderation
 * - imageAnalysis
 * - imageAnalysisStream
 * - ocr
 * - audio transcription
 * - audio transcription stream
 * - text-to-speech
 * - text-to-speech stream
 *
 * @public
 * @description Provider capability implementation for MistralProvider.
 */
export class MistralProvider
    extends BaseProvider
    implements
        ChatCapability<ClientChatRequest>,
        ChatStreamCapability<ClientChatRequest>,
        EmbedCapability<ClientEmbeddingRequest>,
        ModerationCapability<ClientModerationRequest>,
        ImageAnalysisCapability<ClientImageAnalysisRequest>,
        ImageAnalysisStreamCapability<ClientImageAnalysisRequest>,
        OCRCapability<ClientOCRRequest>,
        AudioTranscriptionCapability<ClientAudioTranscriptionRequest>,
        AudioTranscriptionStreamCapability<ClientAudioTranscriptionRequest>,
        TextToSpeechCapability<ClientTextToSpeechRequest>,
        TextToSpeechStreamCapability<ClientTextToSpeechRequest>
{
    /**
     * Underlying official Mistral SDK client.
     */
    private client: Mistral | null = null;
    /**
     * Capability delegates used to keep provider methods thin and capability-specific.
     */
    private chatDelegate: MistralChatCapabilityImpl | null = null;
    private embedDelegate: MistralEmbedCapabilityImpl | null = null;
    private moderationDelegate: MistralModerationCapabilityImpl | null = null;
    private imageAnalysisDelegate: MistralImageAnalysisCapabilityImpl | null = null;
    private ocrDelegate: MistralOCRCapabilityImpl | null = null;
    private audioTranscriptionDelegate: MistralAudioTranscriptionCapabilityImpl | null = null;
    private audioTtsDelegate: MistralAudioTextToSpeechCapabilityImpl | null = null;

    /**
     * Creates a new Mistral provider instance.
     */
    public constructor() {
        super(AIProvider.Mistral);
    }

    /**
     * Initializes the Mistral provider and registers supported capabilities.
     *
     * Responsibilities:
     * - validate API key presence
     * - construct the official SDK client
     * - create capability delegates
     * - register provider capabilities for AIClient routing
     *
     * @param {ProviderConnectionConfig} config Provider connection configuration.
     * @throws {Error} When the configured API key is missing.
     */
    override init(config: ProviderConnectionConfig) {
        if (!config.apiKey) {
            throw new Error(`Mistral API key ${config.apiKeyEnvVar} required but not found in config. Check .env file`);
        }

        this.config = config;
        // Prefer the official SDK just like the other first-class providers so
        // auth, transport, and API-version drift are handled by the vendor client.
        this.client = new Mistral({
            apiKey: config.apiKey,
            ...BaseProvider.sanitizeConstructorParams(config.providerDefaults?.providerParams ?? {})
        });

        // Initialize capability delegates once so all provider methods share the
        // same client and merged config behavior.
        this.chatDelegate = new MistralChatCapabilityImpl(this, this.client);
        this.embedDelegate = new MistralEmbedCapabilityImpl(this, this.client);
        this.moderationDelegate = new MistralModerationCapabilityImpl(this, this.client);
        this.imageAnalysisDelegate = new MistralImageAnalysisCapabilityImpl(this, this.client);
        this.ocrDelegate = new MistralOCRCapabilityImpl(this, this.client);
        this.audioTranscriptionDelegate = new MistralAudioTranscriptionCapabilityImpl(this, this.client);
        this.audioTtsDelegate = new MistralAudioTextToSpeechCapabilityImpl(this, this.client);

        // Register only the capabilities Mistral v1 intentionally supports.
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
        this.registerCapability(
            CapabilityKeys.AudioTranscriptionCapabilityKey,
            this as AudioTranscriptionCapability<ClientAudioTranscriptionRequest, NormalizedChatMessage[]>
        );
        this.registerCapability(
            CapabilityKeys.AudioTranscriptionStreamCapabilityKey,
            this as AudioTranscriptionStreamCapability<ClientAudioTranscriptionRequest, NormalizedChatMessage[]>
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
     * Executes a non-streaming Mistral chat request.
     *
     * @param {AIRequest<ClientChatRequest>} req Unified chat request envelope.
     * @param {MultiModalExecutionContext} executionContext Execution context for timeline/state propagation.
     * @param {AbortSignal} [signal] Optional cancellation signal.
     * @throws {CapabilityUnsupportedError} When the chat delegate is unavailable.
     * @returns {Promise<AIResponse<NormalizedChatMessage>>} Provider-normalized assistant message response.
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
     * Executes a streaming Mistral chat request.
     *
     * @param {AIRequest<ClientChatRequest>} req Unified streaming chat request envelope.
     * @param {MultiModalExecutionContext} executionContext Execution context for timeline/state propagation.
     * @param {AbortSignal} [signal] Optional cancellation signal.
     * @throws {CapabilityUnsupportedError} When the chat stream delegate is unavailable.
     * @returns {AsyncGenerator<AIResponseChunk<NormalizedChatMessage>>} Async stream of normalized chat chunks.
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
     * Executes a Mistral embeddings request.
     *
     * @param {AIRequest<ClientEmbeddingRequest>} req Unified embedding request envelope.
     * @param {MultiModalExecutionContext} executionContext Execution context for timeline/state propagation.
     * @param {AbortSignal} [signal] Optional cancellation signal.
     * @throws {CapabilityUnsupportedError} When the embedding delegate is unavailable.
     * @returns {Promise<AIResponse<NormalizedEmbedding[]>>} Provider-normalized embedding artifacts.
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
     * Executes a Mistral moderation request.
     *
     * @param {AIRequest<ClientModerationRequest>} req Unified moderation request envelope.
     * @param {MultiModalExecutionContext} executionContext Execution context for timeline/state propagation.
     * @param {AbortSignal} [signal] Optional cancellation signal.
     * @throws {CapabilityUnsupportedError} When the moderation delegate is unavailable.
     * @returns {Promise<AIResponse<NormalizedModeration[]>>} Provider-normalized moderation artifacts.
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
     * Executes a Mistral OCR request.
     *
     * @param {AIRequest<ClientOCRRequest>} req Unified OCR request envelope.
     * @param {MultiModalExecutionContext} executionContext Execution context for timeline/state propagation.
     * @param {AbortSignal} [signal] Optional cancellation signal.
     * @throws {CapabilityUnsupportedError} When the OCR delegate is unavailable.
     * @returns {Promise<AIResponse<NormalizedOCRDocument[]>>} Provider-normalized OCR artifacts.
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
     * Executes a non-streaming Mistral image analysis request.
     *
     * @param {AIRequest<ClientImageAnalysisRequest>} req Unified image analysis request envelope.
     * @param {MultiModalExecutionContext} executionContext Execution context for timeline/state propagation.
     * @param {AbortSignal} [signal] Optional cancellation signal.
     * @throws {CapabilityUnsupportedError} When the image analysis delegate is unavailable.
     * @returns {Promise<AIResponse<NormalizedImageAnalysis[]>>} Provider-normalized image analysis artifacts.
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
     * Executes a streaming Mistral image analysis request.
     *
     * @param {AIRequest<ClientImageAnalysisRequest>} req Unified image analysis request envelope.
     * @param {MultiModalExecutionContext} executionContext Execution context for timeline/state propagation.
     * @param {AbortSignal} [signal] Optional cancellation signal.
     * @throws {CapabilityUnsupportedError} When the image-analysis stream delegate is unavailable.
     * @returns {AsyncGenerator<AIResponseChunk<NormalizedImageAnalysis[]>>} Async stream of normalized image analysis chunks.
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
     * Executes a non-streaming Mistral audio transcription request.
     *
     * @param {AIRequest<ClientAudioTranscriptionRequest>} req Unified transcription request envelope.
     * @param {MultiModalExecutionContext} executionContext Execution context for timeline/state propagation.
     * @param {AbortSignal} [signal] Optional cancellation signal.
     * @throws {CapabilityUnsupportedError} When the audio transcription delegate is unavailable.
     * @returns {Promise<AIResponse<NormalizedChatMessage[]>>} Provider-normalized transcript artifacts.
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
     * Executes a streaming Mistral audio transcription request.
     *
     * @param {AIRequest<ClientAudioTranscriptionRequest>} req Unified streaming transcription request envelope.
     * @param {MultiModalExecutionContext} executionContext Execution context for timeline/state propagation.
     * @param {AbortSignal} [signal] Optional cancellation signal.
     * @throws {CapabilityUnsupportedError} When the audio transcription stream delegate is unavailable.
     * @returns {AsyncGenerator<AIResponseChunk<NormalizedChatMessage[]>>} Async stream of transcript chunks.
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
     * Executes a non-streaming Mistral text-to-speech request.
     *
     * @param {AIRequest<ClientTextToSpeechRequest>} req Unified TTS request envelope.
     * @param {MultiModalExecutionContext} executionContext Execution context for timeline/state propagation.
     * @param {AbortSignal} [signal] Optional cancellation signal.
     * @throws {CapabilityUnsupportedError} When the TTS delegate is unavailable.
     * @returns {Promise<AIResponse<NormalizedAudio[]>>} Provider-normalized synthesized audio artifacts.
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
     * Executes a streaming Mistral text-to-speech request.
     *
     * @param {AIRequest<ClientTextToSpeechRequest>} req Unified streaming TTS request envelope.
     * @param {MultiModalExecutionContext} executionContext Execution context for timeline/state propagation.
     * @param {AbortSignal} [signal] Optional cancellation signal.
     * @throws {CapabilityUnsupportedError} When the TTS stream delegate is unavailable.
     * @returns {AsyncGenerator<AIResponseChunk<NormalizedAudio[]>>} Async stream of synthesized audio chunks.
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
