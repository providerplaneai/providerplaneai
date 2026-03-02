import config from "config";
import { isIP } from "node:net";
import { lookup } from "node:dns/promises";
import { CapabilityKeyType, ClientReferenceImage, JobSnapshot, TimelineArtifacts } from "#root/index.js";

/**
 * Default timeout (ms) for remote image fetches. Infinity disables timeout.
 */
const DEFAULT_REMOTE_IMAGE_FETCH_TIMEOUT_MS = Infinity;
/**
 * Default maximum allowed remote image size in bytes (512 MB).
 */
const DEFAULT_MAX_REMOTE_IMAGE_BYTES = 512 * 1024 * 1024; // 512 MB

/**
 * Summarizes a job snapshot as a comma-separated string for logging/debugging.
 * @param snapshot The job snapshot to summarize
 * @returns Summary string
 */
export function summarizeSnapshot(snapshot: JobSnapshot<any, any>) {
    return [
        `id=${snapshot.id}`,
        `status=${snapshot.status}`,
        `schemaVersion=${snapshot.schemaVersion ?? 1}`,
        `startedAt=${snapshot.startedAt ?? "n/a"}`,
        `endedAt=${snapshot.endedAt ?? "n/a"}`,
        `durationMs=${snapshot.durationMs ?? "n/a"}`
    ].join(", ");
}

/**
 * Logs provider attempt metadata for debugging provider fallback chains.
 * @param label Log label
 * @param metadata Metadata object containing providerAttempts
 */
export function logProviderAttempts(label: string, metadata: Record<string, any> | undefined) {
    const attempts = metadata?.providerAttempts;
    if (!Array.isArray(attempts) || attempts.length === 0) {
        console.log(`[${label}] providerAttempts: none`);
        return;
    }
    console.log(`[${label}] providerAttempts:`, JSON.stringify(attempts, null, 2));
}

/**
 * Logs raw payload budget diagnostics for a job or provider.
 * @param label Log label
 * @param metadata Metadata object with raw payload budget fields
 */
export function logRawBudgetDiagnostics(label: string, metadata: Record<string, any> | undefined) {
    console.log(
        `[${label}] raw diagnostics:`,
        JSON.stringify(
            {
                rawPayloadDropped: metadata?.rawPayloadDropped,
                rawPayloadDroppedCount: metadata?.rawPayloadDroppedCount,
                rawPayloadDroppedBytes: metadata?.rawPayloadDroppedBytes,
                rawPayloadStoredBytes: metadata?.rawPayloadStoredBytes
            },
            null,
            2
        )
    );
}

/**
 * Validates that a value is a boolean, or undefined. Throws if not.
 * @param value The value to validate
 * @param fieldName Name of the field for error messages
 */
export function validateBoolean(value: unknown, fieldName: string) {
    if (value === undefined) {
        return;
    }
    if (typeof value !== "boolean") {
        throw new Error(`Invalid field ${fieldName}: expected a boolean`);
    }
}

/**
 * Recursively removes binary-heavy payload fields from objects.
 *
 * Current behavior:
 * - Removes `base64` fields
 * - Removes `url` fields only when they are `data:` URLs
 *
 * This is intentionally generic so snapshots/timelines can sanitize artifacts
 * without provider-specific branching.
 */
export function stripBinaryPayloadFields<T>(value: T): T {
    if (value === null || value === undefined) {
        return value;
    }

    if (Array.isArray(value)) {
        return value.map((item) => stripBinaryPayloadFields(item)) as T;
    }

    if (typeof value !== "object") {
        return value;
    }

    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};

    for (const [key, raw] of Object.entries(source)) {
        if (key === "base64") {
            continue;
        }

        if (key === "url" && typeof raw === "string" && raw.startsWith("data:")) {
            continue;
        }

        out[key] = stripBinaryPayloadFields(raw);
    }

    return out as T;
}

/**
 * Sanitizes timeline artifacts by removing binary-heavy fields.
 */
export function sanitizeTimelineArtifacts(
    artifacts?: Partial<TimelineArtifacts>
): Partial<TimelineArtifacts> | undefined {
    if (!artifacts) {
        return artifacts;
    }
    return stripBinaryPayloadFields(artifacts);
}

/**
 * Ensures a string is a valid Data URI for base64-encoded content.
 * Returns as-is if already a Data URI, otherwise prepends the appropriate prefix.
 * @param base64OrUri Base64 string or existing Data URI
 * @param mimeType MIME type for base64 input (default: "application/octet-stream")
 * @returns Proper Data URI string
 */
export function ensureDataUri(base64OrUri: string, mimeType = "application/octet-stream"): string {
    return base64OrUri.startsWith("data:") ? base64OrUri : `data:${mimeType};base64,${base64OrUri}`;
}

/**
 * Converts a ClientReferenceImage with base64 content into a Data URI string.
 * @param img Reference image object containing base64 data
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
 * Decodes base64 Data URIs directly, or fetches remote images if not a Data URI.
 * @param url URL or Data URI of the image
 * @throws Error if the Data URI is invalid or fetching the remote image fails
 * @returns Promise that resolves to a Buffer containing the image bytes
 */
export async function resolveImageToBytes(url: string): Promise<Buffer> {
    const { remoteImageFetchTimeoutMs, maxRemoteImageBytes } = getImageFetchLimits();

    // 1. Check if it's already a Data URL
    if (url.startsWith("data:")) {
        const base64Data = url.split(",")[1];
        if (!base64Data) {
            throw new Error("Invalid Data URL format");
        }

        const decoded = Buffer.from(base64Data, "base64");
        if (decoded.byteLength > maxRemoteImageBytes) {
            throw new Error(`Image exceeds max allowed size (${maxRemoteImageBytes} bytes)`);
        }
        return decoded;
    }

    // 2. Otherwise, fetch the remote image
    try {
        await assertSafeRemoteImageUrl(url);

        const timeout = AbortSignal.timeout(remoteImageFetchTimeoutMs);
        const response = await fetch(url, { signal: timeout });
        if (!response.ok) {
            throw new Error(`Failed to fetch image: ${response.statusText}`);
        }

        const contentLengthHeader = response.headers.get("content-length");
        if (contentLengthHeader) {
            const contentLength = Number(contentLengthHeader);
            if (Number.isFinite(contentLength) && contentLength > maxRemoteImageBytes) {
                throw new Error(`Image exceeds max allowed size (${maxRemoteImageBytes} bytes)`);
            }
        }

        const reader = response.body?.getReader();
        if (!reader) {
            throw new Error("Failed to read response body");
        }

        const chunks: Uint8Array[] = [];
        let total = 0;
        while (true) {
            const { done, value } = await reader.read();
            if (done) {
                break;
            }
            if (!value) {
                continue;
            }

            total += value.byteLength;
            if (total > maxRemoteImageBytes) {
                throw new Error(`Image exceeds max allowed size (${maxRemoteImageBytes} bytes)`);
            }
            chunks.push(value);
        }

        return Buffer.concat(
            chunks.map((c) => Buffer.from(c)),
            total
        );
    } catch {
        // Keep outward errors generic so URLs/tokens from provider-specific errors are not leaked.
        throw new Error("Could not resolve reference image");
    }
}

/**
 * Gets image fetch timeout and max size limits from config, with defaults.
 * @returns Object with remoteImageFetchTimeoutMs and maxRemoteImageBytes
 */
function getImageFetchLimits(): {
    remoteImageFetchTimeoutMs: number;
    maxRemoteImageBytes: number;
} {
    const raw = config.util.toObject() as { appConfig?: Record<string, unknown> };
    const appConfig = raw.appConfig ?? {};

    const remoteImageFetchTimeoutMs = toNonNegativeInteger(
        appConfig.remoteImageFetchTimeoutMs,
        DEFAULT_REMOTE_IMAGE_FETCH_TIMEOUT_MS
    );
    const maxRemoteImageBytes = toNonNegativeInteger(appConfig.maxRemoteImageBytes, DEFAULT_MAX_REMOTE_IMAGE_BYTES);

    return { remoteImageFetchTimeoutMs, maxRemoteImageBytes };
}

/**
 * Converts a value to a non-negative integer, or returns fallback if invalid.
 * @param value Value to check
 * @param fallback Fallback value if not a non-negative integer
 * @returns Non-negative integer
 */
function toNonNegativeInteger(value: unknown, fallback: number): number {
    return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : fallback;
}

/**
 * Asserts that a remote image URL is safe (not localhost/private IP, only http/https).
 * Resolves DNS and checks for private/loopback/link-local addresses.
 * @param rawUrl The URL to check
 * @throws Error if the URL is unsafe
 */
async function assertSafeRemoteImageUrl(rawUrl: string) {
    let parsed: URL;
    try {
        parsed = new URL(rawUrl);
    } catch {
        throw new Error("Invalid URL");
    }

    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        throw new Error("Only http/https URLs are allowed");
    }

    const hostname = parsed.hostname.toLowerCase();
    if (hostname === "localhost") {
        throw new Error("Localhost URLs are not allowed");
    }

    const ipVersion = isIP(hostname);
    if (ipVersion === 4 && isPrivateIPv4(hostname)) {
        throw new Error("Private IPv4 addresses are not allowed");
    }
    if (ipVersion === 6 && isPrivateIPv6(hostname)) {
        throw new Error("Private IPv6 addresses are not allowed");
    }

    // Resolve DNS and ensure no target address is private/loopback/link-local.
    // This blocks hostname-based SSRF where public-looking hosts resolve internally.
    if (ipVersion === 0) {
        const resolved = await lookup(hostname, { all: true, verbatim: true });
        for (const item of resolved) {
            if ((item.family === 4 && isPrivateIPv4(item.address)) || (item.family === 6 && isPrivateIPv6(item.address))) {
                throw new Error("Resolved private address is not allowed");
            }
        }
    }
}

/**
 * Checks if an IPv4 address is private, loopback, or link-local.
 * @param ip IPv4 address string
 * @returns True if private/loopback/link-local
 */
function isPrivateIPv4(ip: string): boolean {
    const parts = ip.split(".").map((p) => Number(p));
    if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) {
        return true;
    }

    const [a, b] = parts;
    if (a === 10) {
        return true;
    }
    if (a === 127) {
        return true;
    }
    if (a === 169 && b === 254) {
        return true;
    }
    if (a === 172 && b >= 16 && b <= 31) {
        return true;
    }
    if (a === 192 && b === 168) {
        return true;
    }
    return false;
}

/**
 * Checks if an IPv6 address is private, loopback, or link-local.
 * @param ip IPv6 address string
 * @returns True if private/loopback/link-local
 */
function isPrivateIPv6(ip: string): boolean {
    const normalized = ip.toLowerCase();
    if (normalized === "::1") {
        return true;
    }
    const mappedIPv4 = extractMappedIPv4FromIPv6(normalized);
    if (mappedIPv4 && isPrivateIPv4(mappedIPv4)) {
        return true;
    }
    if (normalized.startsWith("fc") || normalized.startsWith("fd")) {
        return true;
    } // ULA
    if (normalized.startsWith("fe80:")) {
        return true;
    } // link-local
    return false;
}

/**
 * Extracts an IPv4 address from an IPv4-mapped IPv6 address, if present.
 * @param ip IPv6 address string
 * @returns IPv4 address string or undefined
 */
function extractMappedIPv4FromIPv6(ip: string): string | undefined {
    // Handle IPv4-mapped IPv6 addresses such as:
    // - ::ffff:127.0.0.1
    // - ::ffff:7f00:1
    if (!ip.startsWith("::ffff:")) {
        return undefined;
    }

    const tail = ip.slice("::ffff:".length);
    if (isIP(tail) === 4) {
        return tail;
    }

    const hexParts = tail.split(":");
    if (hexParts.length !== 2) {
        return undefined;
    }

    const high = Number.parseInt(hexParts[0], 16);
    const low = Number.parseInt(hexParts[1], 16);
    if (!Number.isInteger(high) || !Number.isInteger(low)) {
        return undefined;
    }
    if (high < 0 || high > 0xffff || low < 0 || low > 0xffff) {
        return undefined;
    }

    return [(high >> 8) & 0xff, high & 0xff, (low >> 8) & 0xff, low & 0xff].join(".");
}

/**
 * Robust best-effort JSON parser for LLM-generated text (Gemini/other LLMs).
 * Handles:
 *   1. Full JSON (object or array)
 *   2. Newline-delimited JSON
 *   3. Adjacent JSON objects without newlines: {}{}
 * Fallback: returns a normalized object with `description` and `safety`.
 * Silently ignores unparseable fragments, but logs a warning once per parse.
 *
 * DO NOT use for:
 * - config parsing
 * - API responses
 * - persistence
 * - security-sensitive data
 * @param text LLM-generated text to parse
 * @returns Array of parsed objects or fallback
 */
export function parseBestEffortJson<T = any>(text: string): T[] {
    const trimmed = text.trim();
    if (!trimmed) {
        return [];
    }

    const results: T[] = [];
    let parsingWarningsLogged = false;

    // 1. Try full JSON parse (array or object)
    try {
        const parsed = JSON.parse(trimmed);
        return Array.isArray(parsed) ? parsed : [parsed];
    } catch {}

    // 2. Split by newline first
    const lines = trimmed
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean);

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

/**
 * Validates that a value is a non-negative integer, or undefined. Throws if not.
 * @param value Value to validate
 * @param fieldName Name of the field for error messages
 */
export function validateNonNegativeInteger(value: unknown, fieldName: string) {
    if (value === undefined) {
        return;
    }
    if (!Number.isInteger(value) || (value as number) < 0) {
        throw new Error(`Invalid appConfig.${fieldName}: expected a non-negative integer`);
    }
}

/**
 * Asserts that a value is an array, throws if not.
 * @param capability The capability key.
 * @param value The value to check.
 * @param label Label for error messages.
 * @returns The value as an array.
 * @throws Error if value is not an array.
 */
export function expectArrayForCapability<T>(capability: CapabilityKeyType, value: unknown, label: string): T[] {
    // Ensure value is an array, otherwise throw
    if (!Array.isArray(value)) {
        throw new Error(`Invalid ${label} for capability '${capability}' (expected array)`);
    }
    return value as T[];
}

/**
 * Asserts that a value is an object (not array), throws if not.
 * @param capability The capability key.
 * @param value The value to check.
 * @param label Label for error messages.
 * @returns The value as an object.
 * @throws Error if value is not an object.
 */
export function expectObjectForCapability<T extends object>(capability: CapabilityKeyType, value: unknown, label: string): T {
    // Ensure value is a non-array object, otherwise throw
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error(`Invalid ${label} for capability '${capability}' (expected object)`);
    }
    return value as T;
}

/**
 * Reads a finite number from a source object by key.
 * @param source The object to read from.
 * @param key The key to look up.
 * @returns The number if present and finite, otherwise undefined.
 */
export function readNumber(source: Record<string, unknown>, key: string): number | undefined {
    const value = source[key];
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
