/**
 * @module core/types/exceptions/DuplicateProviderRegistrationError.ts
 * @description Error type thrown when duplicate provider registrations are attempted.
 */
import { AIProviderType } from "#root/index.js";

/**
 * Thrown when attempting to register a provider with a duplicate type and connection name.
 */
/**
 * @public
 * Error thrown when a provider type/connection pair is registered more than once.
 */
export class DuplicateProviderRegistrationError extends Error {
    /**
     * @param {AIProviderType} providerType - Provider identifier.
     * @param {string} connectionName - Conflicting connection name.
     */
    constructor(providerType: AIProviderType, connectionName: string) {
        super(`Provider already registered for ${providerType} with name '${connectionName}'`);
        this.name = "DuplicateProviderRegistrationError";
    }
}
