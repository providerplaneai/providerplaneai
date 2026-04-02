/**
 * @module core/types/AIRequest.ts
 * @description Unified provider-agnostic request envelope used by capability adapters.
 */
/**
 * Unified, provider-agnostic interface for any AI provider call request.
 *
 * Used to send inputs to a capability in a consistent way.
 *
 * @template TInput - Type of the request input.
 */
export interface AIRequest<TInput = unknown> {
    /**
     * The main input payload for the request.
     */
    input: TInput;
    /**
     * Optional timeout in milliseconds
     */
    timeoutMs?: number;
    /**
     * Optional cancellation signal
     */
    signal?: AbortSignal;

    /**
     * Optional provider-specific configuration overrides.
     *
     * - `model`: Override which model to use
     * - `modelParams`: Model-specific tuning parameters (temperature, max tokens, etc.)
     * - `providerParams`: Provider-specific parameters (e.g., API hints)
     * - `generalParams`: Other generic parameters (e.g., auto-continuation)
     */
    options?: {
        model?: string;
        modelParams?: Record<string, unknown>;
        providerParams?: Record<string, unknown>;
        generalParams?: Record<string, unknown>;
    };

    /**
     * Execution context for tracing, debugging, or request correlation.
     * Not sent to the provider.
     */
    context?: {
        /**
         * Optional unique request ID for tracing
         */
        requestId?: string;
        /**
         * Optional arbitrary metadata
         */
        metadata?: Record<string, unknown>;
    };
}
