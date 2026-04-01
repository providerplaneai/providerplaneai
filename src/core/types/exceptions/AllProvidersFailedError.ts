/**
 * @module core/types/exceptions/AllProvidersFailedError.ts
 * @description Error type thrown when a provider fallback chain exhausts all options.
 */
import { ProviderAttemptResult, ProviderRef } from "#root/index.js";

/**
 * Thrown when all providers in an execution policy chain fail to successfully execute a capability.
 *
 * Represents a terminal failure after all fallback attempts have been exhausted.
 */
/**
 * @public
 * Error thrown when all providers in a fallback chain fail.
 */
export class AllProvidersFailedError extends Error {
    /**
     * The capability that was requested
     */
    public readonly capability: string;
    /**
     * The provider chain that was attempted
     */
    public readonly providerChain: ProviderRef[];

    /**
     * Per-provider attempt failures.
     *
     * This list only contains providers that were actually invoked
     * (providers lacking the capability are skipped).
     */
    public readonly attempts: ProviderAttemptResult[];

    /**
     * @param {string} capability - The capability being executed.
     * @param {ProviderRef[]} providerChain - The ordered list of providers that were attempted.
     * @param {ProviderAttemptResult[]} attempts - Attempt records for the providers that were actually invoked.
     */
    constructor(capability: string, providerChain: ProviderRef[], attempts: ProviderAttemptResult[]) {
        super(
            `All providers failed for capability "${capability}". ` +
                `Attempted providers: ${providerChain.map((p) => `${p.providerType}${p.connectionName ? `(${p.connectionName})` : ""}`).join(", ")}.`
        );

        this.name = "AllProvidersFailedError";
        this.capability = capability;
        this.providerChain = providerChain;
        this.attempts = attempts;

        // Maintain proper stack trace
        if (Error.captureStackTrace) {
            Error.captureStackTrace(this, AllProvidersFailedError);
        }
    }

    /**
     * Structured JSON-safe representation intended for API responses.
     *
     * This method:
     * - Avoids stack traces
     * - Avoids provider implementation details
     * - Preserves attempt ordering and latency
     */
    toJSON() {
        return {
            error: {
                type: this.name,
                message: this.message,
                capability: this.capability,
                attempts: this.attempts.map((a) => {
                    if (!a) {
                        return {};
                    }
                    return {
                        providerType: a.providerType,
                        connectionName: a.connectionName,
                        attemptIndex: a.attemptIndex,
                        durationMs: a.durationMs,
                        error: a.error,
                        errorCode: a.errorCode
                    };
                })
            }
        };
    }

    /**
     * Returns a concise, log-safe summary of provider failures.
     *
     * @returns {{ name: string; capability: string; attempts: Array<Record<string, unknown>> }} Summary payload.
     */
    toSummary() {
        return {
            name: this.name,
            capability: this.capability,
            attempts: this.attempts.map((a) => {
                if (!a) {
                    return {};
                }
                return {
                    providerType: a.providerType,
                    connectionName: a.connectionName,
                    durationMs: a.durationMs,
                    error: a.error,
                    errorCode: a.errorCode
                };
            })
        };
    }
}
