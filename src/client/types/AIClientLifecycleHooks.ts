import { AIProviderType, CapabilityKeyType, ProviderRef } from "#root/index.js";

/**
 * Context object describing a single provider attempt (non-streaming or streaming).
 * Used for lifecycle hooks and metrics.
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
 * Result object for a single provider attempt (non-streaming or streaming).
 * Includes timing, error, and chunk emission details for metrics and hooks.
 */
export interface ProviderAttemptResult extends ProviderAttemptContext {
    durationMs: number;
    error?: string;
    chunksEmitted?: number; // optional for streaming providers
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    estimatedCostUsd?: number;
}

/**
 * Interface for AIClient lifecycle hooks, enabling metrics, logging, and custom instrumentation.
 *
 * Implement this interface to receive notifications about execution, attempts, and streaming events.
 */
export interface AIClientLifecycleHooks {
    /**
     * Called once at the start of an execution
     */
    onExecutionStart?: (capability: CapabilityKeyType, providerChain: ProviderRef[]) => void;

    /**
     * Called once at the end of an execution (successful)
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
     * Called each time a streaming provider emits a chunk
     */
    onChunkEmitted?: (chunkMetrics: {
        capability: CapabilityKeyType;
        providerType: AIProviderType;
        connectionName?: string;
        chunkIndex: number;
        chunkTimeMs: number;
    }) => void;
}
