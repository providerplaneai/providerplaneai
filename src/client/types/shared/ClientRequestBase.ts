/**
 * @module client/types/shared/ClientRequestBase.ts
 * @description ProviderPlaneAI source module.
 */
/**
 * Base request interface shared across all client request types.
 *
 * - `model`: Optional provider-agnostic model name.
 * - `options`: Optional tuning options (temperature, max tokens, etc.).
 * - `context`: Optional execution context (requestId, metadata, etc.).
 */
/**
 * @public
 * @description Interface contract for ClientRequestBase.
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
