/**
 * @module client/types/video/ClientVideoGenerationRequest.ts
 * @description Provider-agnostic video generation request contracts.
 */
import { ClientReferenceImage, ClientRequestBase } from "#root/index.js";

/**
 * Shared video durations currently exposed across supported providers.
 *
 * @public
 */
export type ClientVideoGenerationSeconds = "4" | "5" | "6" | "7" | "8" | "12";
/**
 * OpenAI-supported duration values for video generation.
 *
 * @public
 */
export const OPENAI_VIDEO_GENERATION_SECONDS = ["4", "8", "12"] as const;
/**
 * Gemini-supported duration values for video generation.
 *
 * @public
 */
export const GEMINI_VIDEO_GENERATION_SECONDS = ["5", "6", "7", "8"] as const;
/**
 * Shared video output sizes currently exposed through the client API.
 *
 * @public
 */
export type ClientVideoGenerationSize = "720x1280" | "1280x720" | "1024x1792" | "1792x1024";

/**
 * Request payload for provider-agnostic video generation.
 *
 * @public
 */
export interface ClientVideoGenerationRequest extends ClientRequestBase {
    /**
     * Prompt used to generate the video.
     */
    prompt: string;
    /**
     * Optional reference image guidance for generation.
     */
    referenceImage?: ClientReferenceImage;

    /**
     * Optional generation/polling controls.
     */
    params?: {
        model?: string;
        seconds?: ClientVideoGenerationSeconds;
        size?: ClientVideoGenerationSize;
        pollUntilComplete?: boolean;
        pollIntervalMs?: number;
        maxPollMs?: number;
        includeBase64?: boolean;
        downloadVariant?: "video" | "thumbnail" | "spritesheet";
    };
}
