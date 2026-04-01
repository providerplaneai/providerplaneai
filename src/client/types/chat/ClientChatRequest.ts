/**
 * @module client/types/chat/ClientChatRequest.ts
 * @description Client-facing request and helper types.
 */
import { ClientChatMessage, ClientRequestBase } from "#root/index.js";

/**
 * Request payload for multi-turn or single-turn chat interactions.
 *
 * @public
 */
export interface ClientChatRequest extends ClientRequestBase {
    messages: ClientChatMessage[];
}
