import { ClientRequestBase } from "#root/index.js";

/**
 * Request payload for content moderation.
 *
 * - `input`: Single string or array of strings to moderate.
 */
export interface ClientModerationRequest extends ClientRequestBase {
    input: string | string[];
}
