export interface NormalizedUserInput {
    id: string;
    modality:
        | "chat"
        | "embedding"
        | "moderation"
        | "imageGeneration"
        | "imageEdit"
        | "imageAnalysis"
        | "audio"
        | "video"
        | "file";

    /**
     * Raw client request input
     * (messages, strings, images, etc.)
     */
    input: unknown;

    metadata?: {
        requestId?: string;
        [key: string]: unknown;
    };
}
