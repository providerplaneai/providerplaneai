/**
 * @module core/types/shared/SafetyRating.ts
 * @description Shared normalized safety-rating contract.
 */
import { AIProviderType } from "#root/index.js";

/**
 * Provider-agnostic normalized safety or content risk assessment.
 *
 * Used for image analysis, text moderation, audio/video inspection, and compliance logging.
 *
 * Notes:
 * - Providers use different taxonomies, thresholds, and confidence systems.
 * - This interface captures the semantic intent of a safety signal, not a provider's exact schema.
 * - Multiple SafetyRating entries may exist for a single request, covering different categories or detected regions.
 *
 * Typical use cases:
 * - Image analysis (NSFW, violence, hate symbols)
 * - Text moderation
 * - Face or object-level safety flags
 * - Compliance logging and audit trails
 */
/**
 * @public
 * Provider-agnostic normalized safety or content-risk assessment.
 */
export interface SafetyRating {
    /**
     * Provider that emitted this rating
     */
    provider?: AIProviderType;
    /**
     * Normalized category (e.g. "sexual", "violence", "hate", "self-harm")
     */
    categories?: {
        violence?: boolean;
        sexual?: boolean;
        selfHarm?: boolean;
        hate?: boolean;
        harassment?: boolean;
    };
    /**
     * Optional subcategory
     */
    subcategory?: string;
    /**
     * Severity or confidence
     */
    level?: string;
    /**
     * Numeric confidence if available (0–1)
     */
    score?: number;
    /**
     * Optional human-readable explanation or rationale
     */
    reason?: string;
    /**
     * Provider-specific raw payload
     */
    raw?: unknown;
    flagged?: boolean;
}
