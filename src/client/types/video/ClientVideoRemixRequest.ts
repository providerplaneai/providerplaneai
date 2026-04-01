/**
 * @module client/types/video/ClientVideoRemixRequest.ts
 * @description Client-facing request and helper types.
 */
import { ClientRequestBase } from "#root/index.js";

/**
 * Request payload for remixing an existing provider-generated video.
 *
 * @public
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
