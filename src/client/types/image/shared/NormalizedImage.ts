/**
 * Normalized representation of a generated or referenced image.
 * Includes both provider-specific raw data and normalized metadata.
 * Can be a URL or base64 content.
 */
export interface NormalizedImage {
    base64?: string;
    url?: string;
    mimeType: string;
    width?: number;
    height?: number;
    raw: unknown;
    index?: number;
    id: string;
}
