import { ClientMessagePart, NormalizedArtifactBase } from "#root/index.js";

/**
 * Canonical, provider-normalized chat message.
 * Stored in timeline artifacts.
 */
export interface NormalizedChatMessage extends NormalizedArtifactBase {
    role: "system" | "user" | "assistant";

    /**
     * Fully resolved multimodal content
     */
    content: ClientMessagePart[];
}
