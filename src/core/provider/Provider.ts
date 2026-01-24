/* eslint-disable @typescript-eslint/no-empty-object-type */

import { ProviderConnectionConfig } from "#root/index.js";

/**
 * Mapping of provider keys to names
 */
export const AIProvider = {
    OpenAI: "openai",
    Anthropic: "anthropic",
    Gemini: "gemini"
} as const;

export type AIProviderType = (typeof AIProvider)[keyof typeof AIProvider];

/**
 * Root provider interface for all concrete providers (e.g., OpenAIProvider, AnthropicProvider).
 *
 * Responsibilities:
 * - Initialize the provider connection using configuration
 * - Declare support for capabilities via BaseProvider
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
 * Marker interface for provider capabilities.
 * Used for type safety and capability registration.
 */
export interface ProviderCapability {}
