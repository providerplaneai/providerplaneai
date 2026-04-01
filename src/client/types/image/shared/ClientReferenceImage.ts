/**
 * @module client/types/image/shared/ClientReferenceImage.ts
 * @description Shared client-side image reference contracts used by image, OCR, and video requests.
 */
/**
 * Describes a reference image supplied by URL, inline base64, or a provider-native handle.
 *
 * @public
 */
export interface ClientReferenceImage {
    id: string;

    sourceType: "url" | "base64" | "provider";
    /**
     * Public or signed URL
     */
    url?: string;
    /**
     * Raw base64 data (no data: prefix)
     */
    base64?: string;
    /**
     * Required when base64 is used
     */
    mimeType?: string;
    /**
     * Optional semantic role
     */
    role?:
        | "reference" // base image to edit
        | "mask" // transparency / edit mask
        | "control" // controlnet / structural guidance
        | "subject" // subject consistency
        | "style"; // style transfer
    /**
     * Optional strength/weight hint (0–1)
     */
    weight?: number;

    description?: string;
    /**
     * Provider escape hatch
     */
    extras?: Record<string, unknown>;
}
