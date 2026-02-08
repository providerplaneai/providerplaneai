/**
 * Base for all normalized multimodal artifacts
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
