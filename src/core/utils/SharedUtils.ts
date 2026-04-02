/**
 * @module core/utils/SharedUtils.ts
 * @description Shared normalization, data URI, and remote media helpers used across capabilities.
 */
import config from "config";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

import { CapabilityKeyType, ClientReferenceImage, JobSnapshot, TimelineArtifacts } from "#root/index.js";

/**
 * Default timeout (ms) for remote image fetches.
 */
const DEFAULT_REMOTE_IMAGE_FETCH_TIMEOUT_MS = 30_000;
/**
 * Default maximum allowed remote image size in bytes (512 MB).
 */
const DEFAULT_MAX_REMOTE_IMAGE_BYTES = 512 * 1024 * 1024; // 512 MB

/**
 * Summarizes a job snapshot as a compact comma-separated string for logging and diagnostics.
 *
 * @param {JobSnapshot<any, any>} snapshot - Job snapshot to summarize.
 * @returns {string} Human-readable summary string.
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
 * Validates that a value is a boolean when provided.
 *
 * @param {unknown} value - Value to validate.
 * @param {string} fieldName - Field name used in the thrown error.
 * @throws {Error} When `value` is present but not a boolean.
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
 *
 * @template T - Artifact value shape being sanitized.
 * @param {T} value - Value to sanitize.
 * @returns {T} Sanitized value with binary-heavy fields removed recursively.
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
 * Sanitizes timeline artifacts by removing binary-heavy fields such as base64 payloads and Data
 * URI URLs.
 *
 * @param {Partial<TimelineArtifacts> | undefined} artifacts - Timeline artifacts to sanitize.
 * @returns {Partial<TimelineArtifacts> | undefined} Sanitized artifacts, or `undefined` when no artifacts were provided.
 */
export function sanitizeTimelineArtifacts(artifacts?: Partial<TimelineArtifacts>): Partial<TimelineArtifacts> | undefined {
    if (!artifacts) {
        return artifacts;
    }
    return stripBinaryPayloadFields(artifacts);
}

/**
 * Builds result metadata by merging base metadata with capability-specific fields.
 *
 * Undefined values are removed so callers can pass optional fields without
 * polluting response metadata with explicit `undefined` entries.
 *
 * @template TBase - Base metadata shape to preserve.
 * @template TExtra - Additional metadata shape to merge.
 * @param {TBase | undefined} baseMetadata - Existing metadata to preserve, typically from request context.
 * @param {TExtra | undefined} metadata - Capability-specific metadata fields.
 * @returns {TBase & TExtra} Merged metadata object with undefined values removed.
 */
export function buildMetadata<TBase extends Record<string, unknown>, TExtra extends Record<string, unknown>>(
    baseMetadata?: TBase,
    metadata?: TExtra
): TBase & TExtra {
    const merged: Record<string, unknown> = {
        ...(baseMetadata ?? {}),
        ...(metadata ?? {})
    };

    for (const key of Object.keys(merged)) {
        if (merged[key] === undefined) {
            delete merged[key];
        }
    }

    return merged as TBase & TExtra;
}

/**
 * Ensures a payload string is represented as a Data URI.
 *
 * Existing Data URIs are preserved; raw base64 payloads receive a best-effort prefix using the
 * supplied MIME type.
 *
 * @param {string} base64OrUri - Raw base64 payload or existing Data URI.
 * @param {string} mimeType - MIME type used when wrapping raw base64 data.
 * @returns {string} Proper Data URI string.
 */
export function ensureDataUri(base64OrUri: string, mimeType = "application/octet-stream"): string {
    return base64OrUri.startsWith("data:") ? base64OrUri : `data:${mimeType};base64,${base64OrUri}`;
}

/**
 * Removes the `data:<mime>,` or `data:<mime>;base64,` prefix when present.
 *
 * @param {string} value - Data URI or raw payload string.
 * @returns {string} Payload portion without the leading Data URI metadata.
 */
export function stripDataUriPrefix(value: string): string {
    const commaIndex = value.indexOf(",");
    if (value.startsWith("data:") && commaIndex >= 0) {
        return value.slice(commaIndex + 1).trim();
    }
    return value.trim();
}

/**
 * Parses a Data URI into decoded bytes plus MIME metadata.
 *
 * Supports both base64 and URL-encoded payload variants.
 *
 * @param {string} dataUri - Data URI input.
 * @returns {{ bytes: Uint8Array; mimeType: string; isBase64: boolean }} Decoded bytes, MIME type, and original encoding flag.
 * @throws {Error} When the Data URI is malformed
 */
export function parseDataUri(dataUri: string): { bytes: Uint8Array; mimeType: string; isBase64: boolean } {
    const commaIndex = dataUri.indexOf(",");
    if (commaIndex < 0) {
        throw new Error("Invalid data URL");
    }

    const header = dataUri.slice(0, commaIndex);
    const payload = stripDataUriPrefix(dataUri);
    const mimeMatch = /^data:(?:([^;]+))?(;base64)?$/i.exec(header);
    const mimeType = mimeMatch?.[1] ?? "application/octet-stream";
    const isBase64 = /;base64$/i.test(header);

    return {
        bytes: isBase64
            ? new Uint8Array(Buffer.from(payload, "base64"))
            : new Uint8Array(Buffer.from(decodeURIComponent(payload), "utf8")),
        mimeType,
        isBase64
    };
}

/**
 * Decodes a Data URI directly to bytes.
 *
 * @param {string} dataUri - Data URI input.
 * @returns {Uint8Array} Decoded byte payload.
 * @throws {Error} When the Data URI is malformed
 */
export function dataUriToUint8Array(dataUri: string): Uint8Array {
    return parseDataUri(dataUri).bytes;
}

/**
 * Parses a Data URI and returns a Node Buffer payload.
 *
 * @param {string} dataUri - Data URI input.
 * @returns {{ bytes: Buffer; mimeType: string }} Decoded buffer payload with detected MIME type.
 * @throws {Error} When the Data URI is malformed
 */
export function parseDataUriToBuffer(dataUri: string): { bytes: Buffer; mimeType: string } {
    const parsed = parseDataUri(dataUri);
    return {
        bytes: Buffer.from(parsed.bytes),
        mimeType: parsed.mimeType
    };
}

/**
 * Parses a Data URI and returns a base64 payload string.
 *
 * @param {string} dataUri - Data URI input.
 * @returns {{ base64: string; mimeType: string }} Base64 payload with detected MIME type.
 * @throws {Error} When the Data URI is malformed
 */
export function parseDataUriToBase64(dataUri: string): { base64: string; mimeType: string } {
    const parsed = parseDataUri(dataUri);
    return {
        base64: Buffer.from(parsed.bytes).toString("base64"),
        mimeType: parsed.mimeType
    };
}

/**
 * Converts a client reference image with inline base64 content into a Data URI.
 *
 * @param {ClientReferenceImage} img - Reference image carrying base64 content.
 * @returns {string} Data URI string.
 * @throws {Error} When `img.base64` is missing.
 */
export function toDataUrl(img: ClientReferenceImage): string {
    if (!img.base64) {
        throw new Error("Requires base64");
    }

    const mime = img.mimeType ?? "image/png";
    return `data:${mime};base64,${img.base64}`;
}

/**
 * Resolves a reference image URL or Data URI into bytes.
 *
 * Data URIs are decoded locally. Remote URLs are validated against SSRF-style unsafe targets before
 * fetching, then streamed with configurable size and timeout limits.
 *
 * @param {string} url - Remote image URL or Data URI.
 * @returns {Promise<Buffer>} Image bytes.
 * @throws {Error} When the Data URI is invalid, the URL is unsafe, or the remote fetch fails.
 */
export async function resolveImageToBytes(url: string): Promise<Buffer> {
    const { remoteImageFetchTimeoutMs, maxRemoteImageBytes } = getImageFetchLimits();

    // Data URIs are resolved locally and still respect the configured maximum payload size.
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

    try {
        await assertSafeRemoteHttpUrl(url);

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

        const chunks: Buffer[] = [];
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
            chunks.push(Buffer.from(value));
        }

        return Buffer.concat(chunks, total);
    } catch {
        // Keep outward errors generic so URLs/tokens from provider-specific errors are not leaked.
        throw new Error("Could not resolve reference image");
    }
}

/**
 * Reads image-fetch limits from config, falling back to safe defaults.
 *
 * @returns {{ remoteImageFetchTimeoutMs: number; maxRemoteImageBytes: number }} Effective timeout and maximum byte budget for remote image fetches.
 */
function getImageFetchLimits(): {
    remoteImageFetchTimeoutMs: number;
    maxRemoteImageBytes: number;
} {
    const raw = (config.has("providerplane") ? config.get("providerplane") : {}) as { appConfig?: Record<string, unknown> };
    const appConfig = raw.appConfig ?? {};

    const remoteImageFetchTimeoutMs = toNonNegativeInteger(
        appConfig.remoteImageFetchTimeoutMs,
        DEFAULT_REMOTE_IMAGE_FETCH_TIMEOUT_MS
    );
    const maxRemoteImageBytes = toNonNegativeInteger(appConfig.maxRemoteImageBytes, DEFAULT_MAX_REMOTE_IMAGE_BYTES);

    return { remoteImageFetchTimeoutMs, maxRemoteImageBytes };
}

/**
 * Converts a config value into a non-negative integer, or falls back when invalid.
 *
 * @param {unknown} value - Candidate config value.
 * @param {number} fallback - Value to use when the candidate is invalid.
 * @returns {number} Valid non-negative integer.
 */
function toNonNegativeInteger(value: unknown, fallback: number): number {
    return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : fallback;
}

/**
 * Asserts that a remote HTTP(S) URL is safe to fetch.
 *
 * The check rejects localhost, private address ranges, and hostnames that resolve to private
 * addresses to reduce SSRF risk when capabilities download remote images.
 *
 * @param {string} rawUrl - URL to validate.
 * @throws {Error} When the URL is malformed, non-HTTP(S), or resolves to an unsafe target.
 */
export async function assertSafeRemoteHttpUrl(rawUrl: string) {
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
