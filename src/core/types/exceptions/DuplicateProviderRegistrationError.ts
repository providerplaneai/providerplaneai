/**
 * @module core/types/exceptions/DuplicateProviderRegistrationError.ts
 * @description Core shared type definitions used by runtime, providers, and workflows.
 */
import { AIProviderType } from "#root/index.js";

/**
 * Thrown when attempting to register a provider with a duplicate type and connection name.
 */
/**
 * @public
 * @description Implementation class for DuplicateProviderRegistrationError.
 */
export class DuplicateProviderRegistrationError extends Error {
    constructor(providerType: AIProviderType, connectionName: string) {
        super(`Provider already registered for ${providerType} with name '${connectionName}'`);
        this.name = "DuplicateProviderRegistrationError";
    }
}
