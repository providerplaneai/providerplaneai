/**
 * @module core/types/NormalizedUserInput.ts
 * @description Canonical user input envelope stored in timeline user-message events.
 */
/**
 * Normalized user input stored at the start of each logical turn.
 *
 * @public
 */
export interface NormalizedUserInput {
    /** Stable input identifier. */
    id: string;
    /** High-level modality of the originating request. */
    modality: "chat" | "embedding" | "moderation" | "image" | "audio" | "video" | "file" | "ocr" | "custom";

    /**
     * Raw client request input such as messages, strings, images, or files.
     */
    input: unknown;

    /** Optional request-scoped metadata preserved with the user turn. */
    metadata?: Record<string, unknown>;
}
