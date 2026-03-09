/**
 * @module client/types/video/ClientVideoRemixRequest.ts
 * @description ProviderPlaneAI source module.
 */
import { ClientRequestBase } from "#root/index.js";

/**
 * Provider-agnostic video remix request.
 */
/**
 * @public
 * @description Interface contract for ClientVideoRemixRequest.
 */
export interface ClientVideoRemixRequest extends ClientRequestBase {
    /**
     * Existing provider video id to remix from.
     */
    sourceVideoId: string;
    /**
     * Prompt used to direct remix output.
     */
    prompt: string;

    /**
     * Optional polling/download controls.
     */
    params?: {
        pollUntilComplete?: boolean;
        pollIntervalMs?: number;
        maxPollMs?: number;
        includeBase64?: boolean;
        downloadVariant?: "video" | "thumbnail" | "spritesheet";
    };
}
