/**
 * @module client/types/chat/ClientChatMessage.ts
 * @description ProviderPlaneAI source module.
 */
import { ClientMessagePart } from "./ClientMessageParts.js";

/**
 * Represents a single chat message in a conversation.
 *
 * - `role`: The sender's role (system, user, assistant).
 * - `content`: Array of message parts (text, image, audio, etc.).
 */
/**
 * @public
 * @description Interface contract for ClientChatMessage.
 */
export interface ClientChatMessage {
    /**
     * The role of a participant in a chat message.
     * System messages typically provide context or instructions.
     * User messages are from the end-user.
     * Assistant messages are from the AI model.
     */
    role: "system" | "user" | "assistant";
    content: ClientMessagePart[];
}
