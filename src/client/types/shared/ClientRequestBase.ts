/**
 * @module client/types/shared/ClientRequestBase.ts
 * @description Shared base request shape used by provider-agnostic client request contracts.
 */
/**
 * Common fields shared by all client-facing capability requests.
 *
 * @public
 */
export interface ClientRequestBase {
    model?: string;

    /**
     * Provider-agnostic tuning options
     * (temperature, max tokens, etc.)
     */
    options?: Record<string, unknown>;

    /**
     * Execution context (tracing, requestId, etc.)
     * Not sent to the provider.
     */
    context?: {
        requestId?: string;
        metadata?: Record<string, unknown>;
    };
}
