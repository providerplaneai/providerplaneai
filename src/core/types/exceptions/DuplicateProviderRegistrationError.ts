import { AIProviderType } from "#root/index.js";

/**
 * Thrown when attempting to register a provider with a duplicate type and connection name.
 */
export class DuplicateProviderRegistrationError extends Error {
    constructor(providerType: AIProviderType, connectionName: string) {
        super(`Provider already registered for ${providerType} with name '${connectionName}'`);
        this.name = "DuplicateProviderRegistrationError";
    }
}
