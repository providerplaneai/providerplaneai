import { AIProviderType, CapabilityKeyType } from "#root/index.js";

/**
 * Thrown when a provider does not support a requested capability.
 */
export class CapabilityUnsupportedError extends Error {
    constructor(providerType: AIProviderType, capabilityKey: CapabilityKeyType) {
        super(`No capability ${capabilityKey} found for ${providerType} provider`);
        this.name = "CapabilityUnsupportedError";
    }
}
