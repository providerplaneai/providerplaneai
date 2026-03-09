/**
 * @module core/provider/Provider.ts
 * @description Core provider contracts and provider type identifiers.
 */
/* eslint-disable @typescript-eslint/no-empty-object-type */

import { ProviderConnectionConfig } from "#root/index.js";

/**
 * @public
 * @description Canonical provider identifiers used across config, routing, and provider registration.
 */
export const AIProvider = {
    OpenAI: "openai",
    Anthropic: "anthropic",
    Gemini: "gemini"
} as const;

/**
 * @public
 * @description Union of supported provider identifier values.
 */
export type AIProviderType = (typeof AIProvider)[keyof typeof AIProvider];

/**
 * @public
 * @description Minimal provider initialization contract implemented by concrete provider classes.
 */
export interface Provider {
    /**
     * Initialize the provider connection.
     *
     * @param config Provider-specific connection configuration
     * @throws Error if initialization fails
     */
    init(config: ProviderConnectionConfig): Promise<void>;
}

/**
 * @public
 * @description Marker interface for provider capability contracts.
 */
export interface ProviderCapability {}
