/**
 * @module client/types/chat/ClientChatMessage.ts
 * @description Client-facing request and helper types.
 */
import { ClientMessagePart } from "#root/index.js";

/**
 * Represents a single chat turn supplied to a provider-agnostic chat request.
 *
 * @public
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
