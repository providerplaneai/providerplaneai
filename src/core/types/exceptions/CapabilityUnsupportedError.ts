/**
 * @module core/types/exceptions/CapabilityUnsupportedError.ts
 * @description Error type thrown when a provider lacks a requested capability.
 */
import { AIProviderType, CapabilityKeyType } from "#root/index.js";

/**
 * Thrown when a provider does not support a requested capability.
 */
/**
 * @public
 * Error thrown when a provider does not support a requested capability.
 */
export class CapabilityUnsupportedError extends Error {
    /**
     * @param {AIProviderType} providerType - Provider identifier.
     * @param {CapabilityKeyType} capabilityKey - Capability key that was requested.
     */
    constructor(providerType: AIProviderType, capabilityKey: CapabilityKeyType) {
        super(`No capability ${capabilityKey} found for ${providerType} provider`);
        this.name = "CapabilityUnsupportedError";
    }
}
