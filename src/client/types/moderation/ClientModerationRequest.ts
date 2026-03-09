/**
 * @module client/types/moderation/ClientModerationRequest.ts
 * @description ProviderPlaneAI source module.
 */
import { ClientRequestBase } from "#root/index.js";

/**
 * Request payload for content moderation.
 *
 * - `input`: Single string or array of strings to moderate.
 */
/**
 * @public
 * @description Interface contract for ClientModerationRequest.
 */
export interface ClientModerationRequest extends ClientRequestBase {
    input: string | string[];
}
