/**
 * @module client/types/image/generate/ClientImageGenerationRequest.ts
 * @description ProviderPlaneAI source module.
 */
import { ClientReferenceImage, ClientRequestBase } from "#root/index.js";

/**
 * Provider-agnostic image generation request.
 */
/**
 * @public
 * @description Interface contract for ClientImageGenerationRequest.
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
