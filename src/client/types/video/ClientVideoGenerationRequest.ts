import { ClientReferenceImage, ClientRequestBase } from "#root/index.js";

/**
 * Shared duration values used across current providers.
 *
 * Notes:
 * - OpenAI commonly supports 4/8/12.
 * - Gemini (Veo) commonly supports 5-8.
 */
export type ClientVideoGenerationSeconds = "4" | "5" | "6" | "7" | "8" | "12";
export const OPENAI_VIDEO_GENERATION_SECONDS = ["4", "8", "12"] as const;
export const GEMINI_VIDEO_GENERATION_SECONDS = ["5", "6", "7", "8"] as const;
export type ClientVideoGenerationSize = "720x1280" | "1280x720" | "1024x1792" | "1792x1024";

/**
 * Provider-agnostic video generation request.
 */
export interface ClientVideoGenerationRequest extends ClientRequestBase {
    /** Prompt used to generate the video. */
    prompt: string;

    /** Optional reference image guidance for generation. */
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
