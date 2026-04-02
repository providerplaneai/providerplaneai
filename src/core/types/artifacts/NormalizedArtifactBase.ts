/**
 * @module core/types/artifacts/NormalizedArtifactBase.ts
 * @description Shared base contract for normalized multimodal artifacts.
 */
/**
 * Base interface shared by all normalized multimodal artifacts.
 *
 * @public
 */
export interface NormalizedArtifactBase {
    /** Stable artifact identifier. */
    id: string;

    /**
     * Optional provider metadata preserved alongside the normalized artifact.
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
        [key: string]: unknown;
    };

    /**
     * Raw provider-specific payload retained for debugging or advanced consumers.
     */
    raw?: unknown;
}
