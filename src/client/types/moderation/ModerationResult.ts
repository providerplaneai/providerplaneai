/**
 * Provider-agnostic representation of a moderation result for a single input.
 *
 * - `flagged`: Whether the input was flagged.
 * - `categories`: Map of category names to boolean flags.
 * - `categoryScores`: Optional map of category names to confidence scores.
 * - `raw`: Optional raw provider response.
 * - `reason`: Optional human-readable reason for flagging.
 */
export interface ModerationResult {
    flagged: boolean;
    categories: Record<string, boolean>;
    categoryScores?: Record<string, number>;
    raw?: any;
    reason?: string;
}
