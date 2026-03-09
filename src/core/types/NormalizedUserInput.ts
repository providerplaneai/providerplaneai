/**
 * @module core/types/NormalizedUserInput.ts
 * @description Core shared type definitions used by runtime, providers, and workflows.
 */
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
