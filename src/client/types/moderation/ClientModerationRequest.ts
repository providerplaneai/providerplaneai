/**
 * @module client/types/moderation/ClientModerationRequest.ts
 * @description Client-facing request and helper types.
 */
import { ClientRequestBase } from "#root/index.js";

/**
 * Request payload for text moderation.
 *
 * @public
 */
export interface ClientModerationRequest extends ClientRequestBase {
    input: string | string[];
}
