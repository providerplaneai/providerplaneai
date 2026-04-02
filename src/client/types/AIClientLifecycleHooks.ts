/**
 * @module client/types/AIClientLifecycleHooks.ts
 * @description Lifecycle hook contracts for observing AI client execution and provider attempts.
 */
import { AIProviderType, CapabilityKeyType, ProviderRef } from "#root/index.js";

/**
 * Describes a single provider attempt within an AI client execution.
 *
 * @public
 */
export interface ProviderAttemptContext {
    requestId?: string;
    capability: string;
    providerType: AIProviderType;
    connectionName?: string;
    attemptIndex: number;
    startTime: number;
}

/**
 * Captures the result of a single provider attempt, including timing and token metrics.
 *
 * @public
 */
export interface ProviderAttemptResult extends ProviderAttemptContext {
    durationMs: number;
    error?: string;
    errorCode?: string;
    chunksEmitted?: number; // optional for streaming providers
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    estimatedCost?: number;
}

/**
 * Optional callbacks invoked as the client executes providers and emits stream chunks.
 *
 * @public
 */
export interface AIClientLifecycleHooks {
    /**
     * Called once at the start of an execution
     */
    onExecutionStart?: (capability: CapabilityKeyType, providerChain: ProviderRef[]) => void;

    /**
     * Called once at the end of execution (success or failure).
     */
    onExecutionEnd?: (capability: CapabilityKeyType, providerChain: ProviderRef[]) => void;

    /**
     * Called once if the entire execution fails (all providers fail)
     */
    onExecutionFailure?: (capability: CapabilityKeyType, providerChain: ProviderRef[], errors: ProviderAttemptResult[]) => void;

    /**
     * Called when a provider attempt starts
     */
    onAttemptStart?: (ctx: ProviderAttemptContext) => void;

    /**
     * Called when a provider attempt completes successfully
     */
    onAttemptSuccess?: (result: ProviderAttemptResult) => void;

    /**
     * Called when a provider attempt fails
     */
    onAttemptFailure?: (result: ProviderAttemptResult) => void;

    /**
     * Called each time a chunk is emitted to the consumer (may be buffered by orchestration).
     */
    onChunkEmitted?: (chunkMetrics: {
        capability: CapabilityKeyType;
        providerType: AIProviderType;
        connectionName?: string;
        chunkIndex: number;
        chunkTimeMs: number;
    }) => void;
}
