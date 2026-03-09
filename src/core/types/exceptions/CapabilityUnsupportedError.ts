/**
 * @module core/types/exceptions/CapabilityUnsupportedError.ts
 * @description Core shared type definitions used by runtime, providers, and workflows.
 */
import { AIProviderType, CapabilityKeyType } from "#root/index.js";

/**
 * Thrown when a provider does not support a requested capability.
 */
/**
 * @public
 * @description Implementation class for CapabilityUnsupportedError.
 */
export class CapabilityUnsupportedError extends Error {
    constructor(providerType: AIProviderType, capabilityKey: CapabilityKeyType) {
        super(`No capability ${capabilityKey} found for ${providerType} provider`);
        this.name = "CapabilityUnsupportedError";
    }
}
