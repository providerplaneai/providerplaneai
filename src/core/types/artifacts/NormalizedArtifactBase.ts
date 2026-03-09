/**
 * @module core/types/artifacts/NormalizedArtifactBase.ts
 * @description Core shared type definitions used by runtime, providers, and workflows.
 */
/**
 * Base for all normalized multimodal artifacts
 */
/**
 * @public
 * @description Data contract for NormalizedArtifactBase.
 */
export interface NormalizedArtifactBase {
    id: string;

    /**
     * Optional provider metadata, same shape as chat
     */
    metadata?: {
        provider?: string;
        model?: string;
        finishReason?: string;
        usage?: {
            inputTokens?: number;
            outputTokens?: number;
            totalTokens?: number;
        };
        [key: string]: unknown; // extendable for modality-specific data
    };

    /**
     * Raw provider-specific payload
     */
    raw?: unknown;
}
