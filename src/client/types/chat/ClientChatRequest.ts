import { ClientRequestBase } from "../shared/ClientRequestBase.js";
import { ClientChatMessage } from "./ClientChatMessage.js";

/**
 * Provider-agnostic chat request payload.
 *
 * - `messages`: Array of chat messages (multi-turn or single-turn).
 */
export interface ClientChatRequest extends ClientRequestBase {
    messages: ClientChatMessage[];
}
