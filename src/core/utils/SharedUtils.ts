import { ClientReferenceImage } from "#root/index.js";

/**
 * Ensures a string is a valid Data URI for base64-encoded content.
 *
 * - Returns as-is if already a Data URI
 * - Otherwise, prepends the appropriate data URI prefix
 *
 * @param base64OrUri - Base64 string or existing Data URI
 * @param mimeType - MIME type for base64 input (default: "application/octet-stream")
 * @returns Proper Data URI string
 */
export function ensureDataUri(base64OrUri: string, mimeType = "application/octet-stream"): string {
    return base64OrUri.startsWith("data:") ? base64OrUri : `data:${mimeType};base64,${base64OrUri}`;
}

/**
 * Converts a ClientReferenceImage with base64 content into a Data URI string.
 *
 * @param img - Reference image object containing base64 data
 * @throws Error if `img.base64` is not provided
 * @returns Data URI string
 */
export function toDataUrl(img: ClientReferenceImage): string {
    if (!img.base64) {
        throw new Error("Requires base64");
    }

    const mime = img.mimeType ?? "image/png";
    return `data:${mime};base64,${img.base64}`;
}

/**
 * Resolves a reference image URL or Data URI into a Buffer of bytes.
 *
 * - Decodes base64 Data URIs directly
 * - Fetches remote images if not a Data URI
 *
 * @param url - URL or Data URI of the image
 * @throws Error if the Data URI is invalid or fetching the remote image fails
 * @returns Promise that resolves to a Buffer containing the image bytes
 */
export async function resolveImageToBytes(url: string): Promise<Buffer> {
    // 1. Check if it's already a Data URL
    if (url.startsWith("data:")) {
        const base64Data = url.split(",")[1];
        if (!base64Data) {
            throw new Error("Invalid Data URL format");
        }

        return Buffer.from(base64Data, "base64");
    }

    // 2. Otherwise, fetch the remote image
    try {
        const response = await fetch(url);
        if (!response.ok) {
            throw new Error(`Failed to fetch image: ${response.statusText}`);
        }

        const arrayBuffer = await response.arrayBuffer();

        return Buffer.from(arrayBuffer);
    } catch (_error) {
        throw new Error(`Could not resolve reference image: ${url}`);
    }
}
