/**
 * @module client/types/chat/ClientChatRequest.ts
 * @description ProviderPlaneAI source module.
 */
import { ClientChatMessage, ClientRequestBase } from "#root/index.js";

/**
 * Provider-agnostic chat request payload.
 *
 * - `messages`: Array of chat messages (multi-turn or single-turn).
 */
/**
 * @public
 * @description Interface contract for ClientChatRequest.
 */
export interface ClientChatRequest extends ClientRequestBase {
    messages: ClientChatMessage[];
}
