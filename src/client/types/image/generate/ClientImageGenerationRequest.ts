/**
 * @module client/types/image/generate/ClientImageGenerationRequest.ts
 * @description Client-facing request and helper types.
 */
import { ClientReferenceImage, ClientRequestBase } from "#root/index.js";

/**
 * Request payload for text-to-image generation with optional reference guidance.
 *
 * @public
 */
export interface ClientImageGenerationRequest extends ClientRequestBase {
    /**
     * Text prompt describing the desired image
     */
    prompt: string;
    /**
     * Optional reference images to guide generation
     */
    referenceImages?: ClientReferenceImage[];

    /**
     * Additional provider-agnostic generation parameters
     */
    params?: {
        size?: string; // "1024x1024", "wide", etc.
        format?: "png" | "jpeg" | "webp" | "avif";
        quality?: "low" | "medium" | "high" | "ultra";
        style?: string;
        background?: "transparent" | "opaque";
        extras?: Record<string, unknown>;
    };
}
