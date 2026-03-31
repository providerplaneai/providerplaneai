/**
 * @module core/provider/CapabilityExecutorRegistry.ts
 * @description Capability executor contracts and default executor registry wiring.
 */
import {
    AIRequest,
    AIResponse,
    AIResponseChunk,
    BuiltInCapabilityKey,
    CapabilityKeys,
    CapabilityKeyType,
    CapabilityMap,
    CustomCapabilityKey,
    ProviderCapability,
    MultiModalExecutionContext,
    createApprovalGateExecutor,
    createSaveFileExecutor
} from "#root/index.js";

/**
 * Resolves the provider capability interface type for a capability key.
 *
 * @typeParam C Capability key
 * @remarks For custom keys, falls back to the generic `ProviderCapability` marker.
 */
export type CapabilityFor<C extends CapabilityKeyType> = C extends keyof CapabilityMap ? CapabilityMap[C] : ProviderCapability;

/**
 * Executor contract for streaming capabilities.
 *
 * @typeParam C Capability key type
 * @typeParam TInput Request input type
 * @typeParam TOutput Final output type
 * @public
 */
export interface StreamingExecutor<C extends CapabilityKeyType, TInput, TOutput> {
    /** Discriminator indicating this executor yields chunks. */
    streaming: true;
    /**
     * Invokes the streaming capability.
     * @param capability The provider capability implementation.
     * @param input The AIRequest input.
     * @param ctx The multimodal execution context.
     * @param signal Optional abort signal.
     * @returns AsyncGenerator yielding response chunks.
     */
    invoke(
        capability: CapabilityFor<C>,
        input: AIRequest<TInput>,
        ctx: MultiModalExecutionContext,
        signal?: AbortSignal
    ): AsyncGenerator<AIResponseChunk<TOutput>>;
}

/**
 * Executor contract for non-streaming capabilities.
 *
 * @typeParam C Capability key type
 * @typeParam TInput Request input type
 * @typeParam TOutput Response output type
 * @public
 */
export interface NonStreamingExecutor<C extends CapabilityKeyType, TInput, TOutput> {
    /** Discriminator indicating this executor returns a single response. */
    streaming: false;
    /**
     * Invokes the non-streaming capability.
     * @param capability The provider capability implementation.
     * @param input The AIRequest input.
     * @param ctx The multimodal execution context.
     * @param signal Optional abort signal.
     * @returns Promise resolving to a single AIResponse.
     */
    invoke(
        capability: CapabilityFor<C>,
        input: AIRequest<TInput>,
        ctx: MultiModalExecutionContext,
        signal?: AbortSignal
    ): Promise<AIResponse<TOutput>>;
}

/**
 * @public
 * @description Union of streaming and non-streaming executor contracts.
 */
export type CapabilityExecutor<C extends CapabilityKeyType, TInput, TOutput> =
    | StreamingExecutor<C, TInput, TOutput>
    | NonStreamingExecutor<C, TInput, TOutput>;

/**
 * @public
 * @description Mutable registry of capability executors keyed by capability id.
 */
export class CapabilityExecutorRegistry {
    /** Internal mapping from capability key to executor implementation. */
    private executors = new Map<CapabilityKeyType, CapabilityExecutor<any, any, any>>();

    /**
     * Registers a capability executor for a given key.
     * Supports both built-in and custom capability keys.
     *
     * @param key The capability key.
     * @param executor The executor instance.
     * @returns This registry instance.
     */
    register<C extends BuiltInCapabilityKey, TInput = any, TOutput = any>(
        key: C,
        executor: CapabilityExecutor<C, TInput, TOutput>
    ): this;

    register<TInput = any, TOutput = any>(key: CustomCapabilityKey, executor: CapabilityExecutor<any, TInput, TOutput>): this;

    register(key: CapabilityKeyType, executor: CapabilityExecutor<any, any, any>) {
        // Add or replace the executor for the given key
        this.executors.set(key, executor);
        return this; // Allow chaining
    }

    /**
     * Returns the internal map of all executors.
     */
    getExecutors() {
        return this.executors;
    }

    /**
     * Retrieves the executor for a given capability key.
     *
     * @param key The capability key.
     * @throws Error if the executor is not registered.
     */
    get<C extends CapabilityKeyType, TInput = any, TOutput = any>(key: C): CapabilityExecutor<C, TInput, TOutput> {
        const exec = this.executors.get(key);
        if (!exec) {
            throw new Error(`Capability '${key}' not registered`);
        }
        return exec as CapabilityExecutor<C, TInput, TOutput>;
    }

    /**
     * Sets (adds or replaces) the executor for a given capability key.
     *
     * @param key The capability key.
     * @param executor The executor instance.
     */
    set<C extends BuiltInCapabilityKey, TInput = any, TOutput = any>(
        key: C,
        executor: CapabilityExecutor<C, TInput, TOutput>
    ): void;

    set<TInput = any, TOutput = any>(key: CustomCapabilityKey, executor: CapabilityExecutor<any, TInput, TOutput>): void;

    set(key: CapabilityKeyType, executor: CapabilityExecutor<any, any, any>) {
        // Add or replace the executor for the given key
        this.executors.set(key, executor);
    }

    /**
     * Checks if an executor is registered for the given capability key.
     *
     * @param key The capability key.
     * @returns True if registered, false otherwise.
     */
    has(key: CapabilityKeyType): boolean {
        return this.executors.has(key);
    }
}

/**
 * Creates a registry pre-populated with default executors for all built-in capabilities.
 *
 * @returns A CapabilityExecutorRegistry instance with default executors registered.
 */
export function createDefaultExecutors(): CapabilityExecutorRegistry {
    const registry = new CapabilityExecutorRegistry();
    // Capability keys here must stay aligned with provider registrations so
    // AIClient can dispatch by key without capability-specific branching.

    // Register default non-streaming chat executor
    registry.register(CapabilityKeys.ChatCapabilityKey, {
        streaming: false,
        invoke: (capability, input, ctx, signal) => capability.chat(input, ctx, signal)
    });

    // Register default streaming chat executor
    registry.register(CapabilityKeys.ChatStreamCapabilityKey, {
        streaming: true,
        invoke: (capability, input, ctx, signal) => capability.chatStream(input, ctx, signal)
    });

    // Register default non-streaming image generation executor
    registry.register(CapabilityKeys.ImageGenerationCapabilityKey, {
        streaming: false,
        invoke: (capability, input, ctx, signal) => capability.generateImage(input, ctx, signal)
    });

    // Register default streaming image generation executor
    registry.register(CapabilityKeys.ImageGenerationStreamCapabilityKey, {
        streaming: true,
        invoke: (capability, input, ctx, signal) => capability.generateImageStream(input, ctx, signal)
    });

    // Register default non-streaming image analysis executor
    registry.register(CapabilityKeys.ImageAnalysisCapabilityKey, {
        streaming: false,
        invoke: (capability, input, ctx, signal) => capability.analyzeImage(input, ctx, signal)
    });

    // Register default streaming image analysis executor
    registry.register(CapabilityKeys.ImageAnalysisStreamCapabilityKey, {
        streaming: true,
        invoke: (capability, input, ctx, signal) => capability.analyzeImageStream(input, ctx, signal)
    });

    registry.register(CapabilityKeys.OCRCapabilityKey, {
        streaming: false,
        invoke: (capability, input, ctx, signal) => capability.ocr(input, ctx, signal)
    });

    // Register default non-streaming image edit executor
    registry.register(CapabilityKeys.ImageEditCapabilityKey, {
        streaming: false,
        invoke: (capability, input, ctx, signal) => capability.editImage(input, ctx, signal)
    });

    // Register default streaming image edit executor
    registry.register(CapabilityKeys.ImageEditStreamCapabilityKey, {
        streaming: true,
        invoke: (capability, input, ctx, signal) => capability.editImageStream(input, ctx, signal)
    });

    // Register default non-streaming embedding executor
    registry.register(CapabilityKeys.EmbedCapabilityKey, {
        streaming: false,
        invoke: (capability, input, ctx, signal) => capability.embed(input, ctx, signal)
    });

    registry.register(CapabilityKeys.AudioTranscriptionCapabilityKey, {
        streaming: false,
        invoke: (capability, input, ctx, signal) => capability.transcribeAudio(input, ctx, signal)
    });

    registry.register(CapabilityKeys.AudioTranscriptionStreamCapabilityKey, {
        streaming: true,
        invoke: (capability, input, ctx, signal) => capability.transcribeAudioStream(input, ctx, signal)
    });

    registry.register(CapabilityKeys.AudioTranslationCapabilityKey, {
        streaming: false,
        invoke: (capability, input, ctx, signal) => capability.translateAudio(input, ctx, signal)
    });

    registry.register(CapabilityKeys.AudioTextToSpeechCapabilityKey, {
        streaming: false,
        invoke: (capability, input, ctx, signal) => capability.textToSpeech(input, ctx, signal)
    });

    registry.register(CapabilityKeys.AudioTextToSpeechStreamCapabilityKey, {
        streaming: true,
        invoke: (capability, input, ctx, signal) => capability.textToSpeechStream(input, ctx, signal)
    });

    registry.register(CapabilityKeys.VideoGenerationCapabilityKey, {
        streaming: false,
        invoke: (capability, input, ctx, signal) => capability.generateVideo(input, ctx, signal)
    });

    registry.register(CapabilityKeys.VideoDownloadCapabilityKey, {
        streaming: false,
        invoke: (capability, input, ctx, signal) => capability.downloadVideo(input, ctx, signal)
    });

    registry.register(CapabilityKeys.VideoExtendCapabilityKey, {
        streaming: false,
        invoke: (capability, input, ctx, signal) => capability.extendVideo(input, ctx, signal)
    });

    registry.register(CapabilityKeys.VideoAnalysisCapabilityKey, {
        streaming: false,
        invoke: (capability, input, ctx, signal) => capability.analyzeVideo(input, ctx, signal)
    });

    registry.register(CapabilityKeys.VideoRemixCapabilityKey, {
        streaming: false,
        invoke: (capability, input, ctx, signal) => capability.remixVideo(input, ctx, signal)
    });

    // Register built-in approval-gate executor (provider-agnostic).
    registry.register(CapabilityKeys.ApprovalGateCapabilityKey, createApprovalGateExecutor());

    // Register built-in save-file executor (provider-agnostic).
    // Security default: constrain writes to current working directory.
    registry.register(CapabilityKeys.SaveFileCapabilityKey, createSaveFileExecutor({ baseDir: process.cwd() }));

    // Register default non-streaming moderation executor
    registry.register(CapabilityKeys.ModerationCapabilityKey, {
        streaming: false,
        invoke: (capability, input, ctx, signal) => capability.moderation(input, ctx, signal)
    });

    return registry;
}
