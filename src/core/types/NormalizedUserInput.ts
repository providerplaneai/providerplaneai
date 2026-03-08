export interface NormalizedUserInput {
    id: string;
    modality: "chat" | "embedding" | "moderation" | "image" | "audio" | "video" | "file" | "custom";

    /**
     * Raw client request input
     * (messages, strings, images, etc.)
     */
    input: unknown;

    metadata?: Record<string, unknown>;
}
