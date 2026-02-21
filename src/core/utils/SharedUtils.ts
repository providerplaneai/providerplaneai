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

/**
 * Robust best-effort JSON parser for LLM-generated text (Gemini/other LLMs).
 *
 * - Handles:
 *   1. Full JSON (object or array)
 *   2. Newline-delimited JSON
 *   3. Adjacent JSON objects without newlines: {}{}
 * - Fallback: returns a normalized object with `description` and `safety`.
 * - Silently ignores unparseable fragments, but logs a warning once per parse.
 *
 * DO NOT use for:
 * - config parsing
 * - API responses
 * - persistence
 * - security-sensitive data
 */
export function parseBestEffortJson<T = any>(text: string): T[] {
    const trimmed = text.trim();
    if (!trimmed) return [];

    const results: T[] = [];
    let parsingWarningsLogged = false;

    // 1. Try full JSON parse (array or object)
    try {
        const parsed = JSON.parse(trimmed);
        return Array.isArray(parsed) ? parsed : [parsed];
    } catch { }

    // 2. Split by newline first
    const lines = trimmed.split("\n").map(l => l.trim()).filter(Boolean);

    for (const line of lines) {
        // 3. Handle adjacent objects without newline: e.g. `{}{}`
        const potentialObjects = line.split(/(?<=})\s*(?=\{)/);

        for (const objText of potentialObjects) {
            try {
                const parsed = JSON.parse(objText);
                results.push(parsed);
            } catch {
                if (!parsingWarningsLogged) {
                    //console.warn("[parseBestEffortJson] Skipping unparseable JSON fragment:", objText);
                    parsingWarningsLogged = true;
                }
            }
        }
    }

    // 4. If nothing parsed, return fallback
    if (!results.length) {
        return [trimmed] as T[];
    }

    return results;
}

export function validateNonNegativeInteger(value: unknown, fieldName: string) {
    if (value === undefined) return;
    if (!Number.isInteger(value) || (value as number) < 0) {
        throw new Error(`Invalid appConfig.${fieldName}: expected a non-negative integer`);
    }
}