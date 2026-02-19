import {
    AIRequest,
    AIResponse,
    AIResponseChunk,
    BaseProvider,
    CapabilityKeys,
    CapabilityKeyType,
    CapabilityMap,
    MultiModalExecutionContext
} from "#root/index.js";

export interface StreamingExecutor<C extends CapabilityKeyType, TInput, TOutput> {
    streaming: true;
        invoke(
        capability: CapabilityMap[C],
        input: AIRequest<TInput>,
        ctx: MultiModalExecutionContext,
        signal?: AbortSignal
    ): AsyncGenerator<AIResponseChunk<TOutput>>;
}

export interface NonStreamingExecutor<C extends CapabilityKeyType, TInput, TOutput> {
    streaming: false;
    invoke(
        capability: CapabilityMap[C],
        input: AIRequest<TInput>,
        ctx: MultiModalExecutionContext,
        signal?: AbortSignal
    ):Promise<TOutput>
}

export type CapabilityExecutor<C extends CapabilityKeyType, TInput, TOutput> = 
    StreamingExecutor<C, TInput, TOutput> | NonStreamingExecutor<C, TInput, TOutput>;

export class CapabilityExecutorRegistry {
    private executors = new Map<CapabilityKeyType, CapabilityExecutor<any, any, any>>();

    register<C extends CapabilityKeyType, TInput = any, TOutput = any>(
        key: C,
        executor: CapabilityExecutor<C, TInput, TOutput>
    ) {
        this.executors.set(key, executor);
        return this; // Allow chaining
    }

    getExecutors(){
        return this.executors;
    }

    get<C extends CapabilityKeyType, TInput = any, TOutput = any>(key: C): CapabilityExecutor<C, TInput, TOutput> {
        const exec = this.executors.get(key);
        if (!exec) {
            throw new Error(`Capability '${key}' not registered`);
        }
        return exec as CapabilityExecutor<C, TInput, TOutput>;
    }

    set<C extends CapabilityKeyType, TInput = any, TOutput = any>(
        key: C,
        executor: CapabilityExecutor<C, TInput, TOutput>
    ) {
        this.executors.set(key, executor);
    }

    has(key: CapabilityKeyType): boolean {
        return this.executors.has(key);
    }
}

export function createDefaultExecutors(): CapabilityExecutorRegistry {
    const registry = new CapabilityExecutorRegistry();

    // Register default executors here if needed

    /* =========================================================
       CHAT (non-streaming)
       ========================================================= */

    registry.register(
        CapabilityKeys.ChatCapabilityKey,
        {
            streaming: false,
            invoke: (capability, input, ctx, signal) => capability.chat(input, ctx, signal)
        }
    );

    /* =========================================================
       CHAT STREAM
       ========================================================= */

    registry.register(
        CapabilityKeys.ChatStreamCapabilityKey,
        {
            streaming: true,
            invoke: (capability, input, ctx, signal) => capability.chatStream(input, ctx, signal)
        }
    );

    /* =========================================================
       IMAGE GENERATION (non-streaming)
       ========================================================= */

    registry.register(
        CapabilityKeys.ImageGenerationCapabilityKey,
        {
            streaming: false,
            invoke: (capability, input, ctx, signal) => capability.generateImage(input, ctx, signal)
        }
    );

    /* =========================================================
       IMAGE GENERATION STREAM
       ========================================================= */

    registry.register(
        CapabilityKeys.ImageGenerationStreamCapabilityKey,
        {
            streaming: true,
            invoke: (capability, input, ctx, signal) => capability.generateImageStream(input, ctx, signal)
        }
    );

    /* =========================================================
       IMAGE ANALYSIS (non-streaming)
       ========================================================= */

    registry.register(
        CapabilityKeys.ImageAnalysisCapabilityKey,
        {
            streaming: false,
            invoke: (capability, input, ctx, signal) => capability.analyzeImage(input, ctx, signal)
        }
    );

    /* =========================================================
       IMAGE ANALYSIS STREAM
       ========================================================= */

    registry.register(
        CapabilityKeys.ImageAnalysisStreamCapabilityKey,
        {
            streaming: true,
            invoke: (capability, input, ctx, signal) => capability.analyzeImageStream(input, ctx, signal)
        }
    );

    /* =========================================================
       IMAGE EDIT (non-streaming)
       ========================================================= */

    registry.register(
        CapabilityKeys.ImageEditCapabilityKey,
        {
            streaming: false,
            invoke: (capability, input, ctx, signal) => capability.editImage(input, ctx, signal)
        }
    );

    /* =========================================================
       IMAGE EDIT STREAM
       ========================================================= */

    registry.register(
        CapabilityKeys.ImageEditStreamCapabilityKey,
        {
            streaming: true,
            invoke: (capability, input, ctx, signal) => capability.editImageStream(input, ctx, signal)
        }
    );

    /* =========================================================
       EMBEDDINGS
       ========================================================= */

    registry.register(
        CapabilityKeys.EmbedCapabilityKey,
        {
            streaming: false,
            invoke: (capability, input, ctx, signal) => capability.embed(input, ctx, signal)
        }
    );

    /* =========================================================
       MODERATION
       ========================================================= */

    registry.register(
        CapabilityKeys.ModerationCapabilityKey,
        {
            streaming: false,
            invoke: (capability, input, ctx, signal) => capability.moderation(input, ctx, signal)
        }
    );

    return registry;
}