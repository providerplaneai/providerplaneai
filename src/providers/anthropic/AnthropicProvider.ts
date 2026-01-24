import Anthropic from "@anthropic-ai/sdk";
import {
    AIProvider,
    AIRequest,
    AIResponse,
    AIResponseChunk,
    AnthropicChatCapabilityImpl,
    AnthropicEmbedCapabilityImpl,
    AnthropicModerationCapabilityImpl,
    BaseProvider,
    CapabilityKeys,
    CapabilityUnsupportedError,
    ChatCapability,
    ChatStreamCapability,
    ClientChatRequest,
    ClientEmbeddingRequest,
    ClientModerationRequest,
    EmbedCapability,
    ModerationCapability,
    ModerationResult,
    MultiModalExecutionContext,
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
        ModerationCapability<ClientModerationRequest>
{
    /** Underlying Anthropic SDK client instance */
    private client: Anthropic | null = null;

    /** Capability delegate implementations */
    private chatDelegate: AnthropicChatCapabilityImpl | null = null;
    private moderateDelegate: AnthropicModerationCapabilityImpl | null = null;
    private embedDelegate: AnthropicEmbedCapabilityImpl | null = null;

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
        console.log(`Initializing Anthropic Provider`);

        // Initialization logic for Anthropic provider`
        if (!config.apiKey) {
            throw new Error(`Anthropic API key ${config.apiKeyEnvVar} required but not found in config. Check .env file`);
        }
        this.config = config;
        this.client = new Anthropic({
            apiKey: config.apiKey,
            ...(config.providerDefaults?.providerParams ?? {})
        });

        // Initialize capability delegates
        this.chatDelegate = new AnthropicChatCapabilityImpl(this, this.client);
        this.moderateDelegate = new AnthropicModerationCapabilityImpl(this, this.client);
        this.embedDelegate = new AnthropicEmbedCapabilityImpl(this);

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
    }

    /**
     * Execute a non-streaming chat request.
     *
     * @template TChatInput Chat request type
     * @param req - Unified AI request containing chat input and options
     * @param executionContext Execution context
     * @returns AIResponse containing generated text output
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
     * @template TChatInput Chat request type
     * @param req - Unified AI request containing chat input and options
     * @param executionContext Execution context
     * @returns AsyncGenerator emitting streamed response chunks
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
     * @template TModerationInput Moderation request type
     * @param req - Unified AI request containing moderation input
     * @param executionContext Execution context
     * @returns AIResponse containing moderation result(s)
     */
    async moderation(
        req: AIRequest<ClientModerationRequest>,
        executionContext: MultiModalExecutionContext
    ): Promise<AIResponse<ModerationResult | ModerationResult[]>> {
        if (!this.moderateDelegate || typeof this.moderateDelegate.moderation !== "function") {
            throw new CapabilityUnsupportedError(this.providerType, CapabilityKeys.ModerationCapabilityKey);
        }
        return await this.moderateDelegate.moderation(req, executionContext);
    }

    /**
     * Execute an embedding request.
     *
     * @template TEmbedInput Embedding request type
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
}
