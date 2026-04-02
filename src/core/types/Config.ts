/**
 * @module core/types/Config.ts
 * @description Configuration contracts for providers, models, and application execution policy.
 */
import { AIProviderType } from "#root/index.js";

/**
 * Base configuration interface for AI models within a provider.
 *
 * Represents per-capability options for a specific model.
 *
 * @template TChatOptions - Options for chat capability.
 * @template TStreamOptions - Options for streaming chat.
 * @template TEmbedOptions - Options for embeddings.
 * @template TImageOptions - Options for image generation.
 * @template TAudioOptions - Options for audio requests.
 * @template TVideoOptions - Options for video requests.
 * @template TModerationOptions - Options for moderation.
 */
export interface ModelConfig<
    TChatOptions extends Record<string, any> = Record<string, any>,
    TStreamOptions extends Record<string, any> = Record<string, any>,
    TEmbedOptions extends Record<string, any> = Record<string, any>,
    TImageOptions extends Record<string, any> = Record<string, any>,
    TAudioOptions extends Record<string, any> = Record<string, any>,
    TVideoOptions extends Record<string, any> = Record<string, any>,
    TModerationOptions extends Record<string, any> = Record<string, any>
> {
    /**
     * Chat capability configuration
     */
    chat?: TChatOptions;
    /**
     * Streaming chat capability configuration
     */
    stream?: TStreamOptions;
    /**
     * Embedding capability configuration
     */
    embedding?: TEmbedOptions;
    /**
     * Image generation capability configuration
     */
    image?: TImageOptions;
    /**
     * Audio capability configuration (future)
     */
    audio?: TAudioOptions;
    /**
     * Video capability configuration (future)
     */
    video?: TVideoOptions;
    /**
     * Moderation capability configuration
     */
    moderation?: TModerationOptions;
    /**
     * Any additional provider-specific extensions
     */
    [key: string]: unknown;
}

/**
 * Configuration representing a single connection for a provider.
 *
 * Contains:
 * - API keys / credentials
 * - Default model configuration
 * - All model definitions
 * - Provider-specific overrides
 */
/**
 * @public
 * Configuration representing a single provider connection.
 */
export interface ProviderConnectionConfig {
    /**
     * Type of the provider, eg. 'openai', 'anthropic', 'huggingface'
     */
    type: AIProviderType;
    /**
     * Name of the environment variable containing the API key
     */
    apiKeyEnvVar?: string;
    /**
     * API key from the environment variable
     */
    apiKey?: string;
    /**
     * Overall default model for general-purpose requests
     */
    defaultModel?: string;

    /**
     * Maps each capability to a default model.
     * Keys correspond to unified method names like 'chat', 'imageGenerate', 'audioTts', etc...
     */
    defaultModels: Record<string, string>;

    /**
     * Definitions of all models available on this connection.
     * The key is the model name, and the value is its config.
     */
    models: Record<string, ModelConfig>;

    /**
     * Override for any unknown provider specific configs
     */
    [key: string]: any;
}

/**
 * Represents all connections for a given provider type, keyed by connection name.
 *
 * @public
 */
export interface ProviderConfigMap {
    [connectionName: string]: ProviderConnectionConfig;
}

/**
 * Identifies a provider connection by provider type and connection name.
 *
 * @public
 */
export interface ProviderRef {
    providerType: AIProviderType;
    connectionName: string;
}

/**
 * Execution policy configuration declared in `appConfig`.
 *
 * @public
 */
export interface ExecutionPolicyConfig {
    providerChain: ProviderRef[];
}

/**
 * Top-level application configuration.
 *
 * @public
 */
export interface AppConfig {
    /**
     * General app specific configs
     */
    appConfig?: {
        /**
         * Maximum number of concurrent jobs allowed
         */
        maxConcurrency?: number;
        /**
         * Maximum number of queued jobs allowed (undefined means unbounded)
         */
        maxQueueSize?: number;
        /**
         * Maximum number of response chunks to store
         */
        maxStoredResponseChunks?: number;
        /**
         * Whether to retain raw provider payloads in job response/chunk diagnostics
         */
        storeRawResponses?: boolean;
        /**
         * Whether to strip binary-heavy fields (e.g. base64) from snapshots and timeline artifacts
         */
        stripBinaryPayloadsInSnapshotsAndTimeline?: boolean;
        /**
         * Maximum raw response bytes retained per job (undefined means unbounded)
         */
        maxRawBytesPerJob?: number;
        /**
         * Timeout (ms) when fetching remote images by URL
         */
        remoteImageFetchTimeoutMs?: number;
        /**
         * Maximum bytes allowed when decoding/fetching images
         */
        maxRemoteImageBytes?: number;
        /**
         * Execution policy configuration
         */
        executionPolicy: ExecutionPolicyConfig;
    };
    /**
     * Mapping of provider types to their connections
     */
    providers: Record<AIProviderType, ProviderConfigMap>;
}

/**
 * Encapsulates provider- and model-specific capability parameters.
 *
 * @public
 */
export interface CapabilityConfig {
    /**
     * Parameters specific to the model
     */
    modelParams?: Record<string, any>;
    /**
     * Parameters specific to the provider
     */
    providerParams?: Record<string, any>;
    /**
     * General parameters that may affect multiple capabilities
     */
    generalParams?: Record<string, any>;
}
