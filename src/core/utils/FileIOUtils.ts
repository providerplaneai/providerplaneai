/**
 * @module core/utils/FileIOUtils.ts
 * @description Shared file/source utilities used by provider adapters.
 */
import { access, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { ensureDataUri, parseDataUri, stripDataUriPrefix } from "#root/index.js";

/**
 * Normalized in-memory representation of a byte-backed caller input.
 */
export type ResolvedBinarySource = {
    /** Resolved input bytes. */
    bytes: Uint8Array;
    /** Best-effort MIME type inferred from the source or supplied by the caller. */
    mimeType: string;
    /** Filename carried forward for provider uploads. */
    fileName: string;
    /** Source category used while normalizing the input. */
    sourceKind: "data-uri" | "local-file" | "blob" | "buffer" | "uint8array" | "arraybuffer" | "stream";
};

/**
 * Normalized representation of reference media that may stay remote or be inlined as base64.
 */
export type ResolvedReferenceMediaSource =
    | { kind: "base64"; base64: string; mimeType: string }
    | { kind: "url"; url: string; mimeType: string };

/**
 * Resolution controls for byte-backed input normalization.
 */
export type ResolveBinarySourceOptions = {
    /** Preferred filename to use for the normalized source. */
    filenameHint?: string;
    /** Preferred MIME type to use when the caller already knows it. */
    mimeTypeHint?: string;
    /** Default filename when none can be derived from the source. */
    defaultFileName?: string;
    /** Default MIME type when no better signal is available. */
    defaultMimeType?: string;
    /** Optional filename-based MIME inference function for local file paths. */
    inferMimeTypeFromPath?: (filePath: string) => string | undefined;
    /** Abort signal checked after file/stream reads complete. */
    signal?: AbortSignal;
    /** Error used when a string source is neither a data URI nor a local path. */
    invalidStringMessage?: string;
    /** Error used when the source shape is unsupported. */
    unsupportedSourceMessage?: string;
    /** Error used when aborting a file read. */
    fileAbortMessage?: string;
    /** Error used when aborting a stream read. */
    streamAbortMessage?: string;
};

/**
 * Best-effort runtime check for Blob/File-like inputs.
 *
 * @param {unknown} value - Candidate input.
 * @returns {value is Blob} Whether the value exposes the Blob/File shape used across providers.
 */
export function isBlobLike(value: unknown): value is Blob {
    return (
        !!value &&
        typeof value === "object" &&
        typeof (value as Blob).arrayBuffer === "function" &&
        typeof (value as Blob).type === "string"
    );
}

/**
 * Best-effort extraction of a filename from a local path.
 *
 * @param {string} filePath - Local filesystem path.
 * @param {string} fallback - Default name when no basename can be derived.
 * @returns {string} Basename fallback for uploads.
 */
export function fileNameFromPath(filePath: string, fallback = "input"): string {
    const normalized = filePath.replace(/\\/g, "/");
    const name = normalized.split("/").pop();
    return name && name.length > 0 ? name : fallback;
}

/**
 * Best-effort extraction of a Blob/File name.
 *
 * @param {Blob} blob - Browser Blob/File input.
 * @returns {string | undefined} Name when present.
 */
export function extractBlobName(blob: Blob): string | undefined {
    return "name" in blob && typeof blob.name === "string" ? blob.name : undefined;
}

/**
 * Runtime check for Node readable streams without importing Node stream modules.
 *
 * @param {unknown} value - Candidate input.
 * @returns {value is NodeJS.ReadableStream} Whether the value behaves like a Node readable stream.
 */
export function isNodeReadableStream(value: unknown): value is NodeJS.ReadableStream {
    return typeof value === "object" && value !== null && typeof (value as NodeJS.ReadableStream).pipe === "function";
}

/**
 * Async existence check for local filesystem paths.
 *
 * @param {string} filePath - Path to test.
 * @returns {Promise<boolean>} `true` when the path is accessible.
 */
export async function pathExists(filePath: string): Promise<boolean> {
    try {
        await access(filePath);
        return true;
    } catch {
        return false;
    }
}

/**
 * Reads a local file into a Buffer.
 *
 * @param {string} filePath - Local filesystem path.
 * @param {AbortSignal | undefined} signal - Optional cancellation signal checked after the read completes.
 * @param {string} abortMessage - Error message used when the read is aborted.
 * @returns {Promise<Buffer>} File bytes as a Buffer.
 * @throws {Error} When the read is aborted after completion.
 */
export async function readFileToBuffer(
    filePath: string,
    signal?: AbortSignal,
    abortMessage = "Request aborted while reading file input"
): Promise<Buffer> {
    const bytes = await readFile(filePath);
    if (signal?.aborted) {
        throw new Error(abortMessage);
    }
    return Buffer.from(bytes);
}

/**
 * Reads a local file into a Uint8Array.
 *
 * @param {string} filePath - Local filesystem path.
 * @param {AbortSignal | undefined} signal - Optional cancellation signal checked after the read completes.
 * @param {string} abortMessage - Error message used when the read is aborted.
 * @returns {Promise<Uint8Array>} File bytes as a Uint8Array.
 * @throws {Error} When the read is aborted after completion.
 */
export async function readFileToUint8Array(
    filePath: string,
    signal?: AbortSignal,
    abortMessage = "Request aborted while reading file input"
): Promise<Uint8Array> {
    return new Uint8Array(await readFileToBuffer(filePath, signal, abortMessage));
}

/**
 * Reads a Node readable stream into a single Buffer.
 *
 * @param {NodeJS.ReadableStream} stream - Node readable stream input.
 * @param {AbortSignal | undefined} signal - Optional cancellation signal checked between chunks.
 * @param {string} abortMessage - Error message used when the read is aborted.
 * @returns {Promise<Buffer>} Collected stream bytes.
 * @throws {Error} When the read is aborted while consuming the stream.
 */
export async function readNodeReadableStreamToBuffer(
    stream: NodeJS.ReadableStream,
    signal?: AbortSignal,
    abortMessage = "Request aborted while reading stream input"
): Promise<Buffer> {
    const chunks: Buffer[] = [];

    for await (const chunk of stream as AsyncIterable<Buffer | Uint8Array | string>) {
        if (signal?.aborted) {
            throw new Error(abortMessage);
        }

        chunks.push(Buffer.from(chunk));
    }

    return Buffer.concat(chunks);
}

/**
 * Reads a Node readable stream into a single Uint8Array.
 *
 * @param {NodeJS.ReadableStream} stream - Node readable stream input.
 * @param {AbortSignal | undefined} signal - Optional cancellation signal checked between chunks.
 * @param {string} abortMessage - Error message used when the read is aborted.
 * @returns {Promise<Uint8Array>} Collected stream bytes.
 * @throws {Error} When the read is aborted while consuming the stream.
 */
export async function readNodeReadableStreamToUint8Array(
    stream: NodeJS.ReadableStream,
    signal?: AbortSignal,
    abortMessage = "Request aborted while reading stream input"
): Promise<Uint8Array> {
    return new Uint8Array(await readNodeReadableStreamToBuffer(stream, signal, abortMessage));
}

/**
 * Reads a local text file.
 *
 * @param {string} filePath - Local filesystem path.
 * @returns {Promise<string>} File content as UTF-8 text.
 */
export async function readTextFile(filePath: string): Promise<string> {
    return readFile(filePath, "utf8");
}

/**
 * Ensures the parent directory for a target file path exists.
 *
 * @param {string} filePath - Destination file path.
 */
export async function ensureParentDirectory(filePath: string): Promise<void> {
    await mkdir(path.dirname(filePath), { recursive: true });
}

/**
 * Writes a text, JSON, or binary payload to disk.
 *
 * @param {string} filePath - Destination file path.
 * @param {string | Buffer | Uint8Array} data - Payload to write.
 * @param {{ encoding?: BufferEncoding; ensureDir?: boolean } | undefined} options - Optional write controls.
 */
export async function writeFileContent(
    filePath: string,
    data: string | Buffer | Uint8Array,
    options?: { encoding?: BufferEncoding; ensureDir?: boolean }
): Promise<void> {
    if (options?.ensureDir) {
        await ensureParentDirectory(filePath);
    }
    await writeFile(
        filePath,
        data as any,
        typeof data === "string" && options?.encoding ? { encoding: options.encoding } : undefined
    );
}

/**
 * Best-effort removal of a file path.
 *
 * @param {string} filePath - File to remove.
 */
export async function removeFileIfExists(filePath: string): Promise<void> {
    await unlink(filePath).catch(() => undefined);
}

/**
 * Creates a temporary file path without writing anything to disk.
 *
 * @param {string} prefix - Prefix used in the generated filename.
 * @param {string | undefined} extension - Optional extension without leading dot.
 * @returns {Promise<string>} Temporary filesystem path.
 */
export async function createTempFilePath(prefix: string, extension?: string): Promise<string> {
    const [{ tmpdir }, path] = await Promise.all([import("node:os"), import("node:path")]);
    const suffix = extension ? `.${extension.replace(/^\./, "")}` : "";
    return path.join(tmpdir(), `${prefix}-${crypto.randomUUID()}${suffix}`);
}

/**
 * Normalizes a byte-backed input source into in-memory bytes plus best-effort metadata.
 *
 * This helper intentionally does not accept remote URLs as a supported source
 * form. Providers that support remote fetch-by-URL should branch on that before
 * calling this helper.
 *
 * @param {unknown} source - Byte-backed caller input.
 * @param {ResolveBinarySourceOptions} options - Optional resolution controls.
 * @returns {Promise<ResolvedBinarySource>} Normalized source bytes, MIME type, filename, and source kind.
 * @throws {Error} When the input is an unsupported shape or a string that is neither a data URI nor
 * a local file path.
 */
export async function resolveBinarySource(
    source: unknown,
    options: ResolveBinarySourceOptions = {}
): Promise<ResolvedBinarySource> {
    const defaultFileName = options.defaultFileName ?? "input";
    const defaultMimeType = options.defaultMimeType ?? "application/octet-stream";

    if (typeof source === "string") {
        if (/^data:/i.test(source)) {
            const parsed = parseDataUri(source);
            return {
                bytes: parsed.bytes,
                mimeType: options.mimeTypeHint ?? parsed.mimeType ?? defaultMimeType,
                fileName: options.filenameHint ?? defaultFileName,
                sourceKind: "data-uri"
            };
        }

        if (await pathExists(source)) {
            return {
                bytes: await readFileToUint8Array(
                    source,
                    options.signal,
                    options.fileAbortMessage ?? "Request aborted while reading file input"
                ),
                mimeType: options.mimeTypeHint ?? options.inferMimeTypeFromPath?.(source) ?? defaultMimeType,
                fileName: options.filenameHint ?? fileNameFromPath(source, defaultFileName),
                sourceKind: "local-file"
            };
        }

        throw new Error(options.invalidStringMessage ?? "String input must be a data URL or local file path");
    }

    if (isBlobLike(source)) {
        return {
            bytes: new Uint8Array(await source.arrayBuffer()),
            mimeType: options.mimeTypeHint ?? (source.type || defaultMimeType),
            fileName: options.filenameHint ?? extractBlobName(source) ?? defaultFileName,
            sourceKind: "blob"
        };
    }

    if (typeof Buffer !== "undefined" && Buffer.isBuffer(source)) {
        return {
            bytes: new Uint8Array(source),
            mimeType: options.mimeTypeHint ?? defaultMimeType,
            fileName: options.filenameHint ?? defaultFileName,
            sourceKind: "buffer"
        };
    }

    if (source instanceof Uint8Array) {
        return {
            bytes: source,
            mimeType: options.mimeTypeHint ?? defaultMimeType,
            fileName: options.filenameHint ?? defaultFileName,
            sourceKind: "uint8array"
        };
    }

    if (source instanceof ArrayBuffer) {
        return {
            bytes: new Uint8Array(source),
            mimeType: options.mimeTypeHint ?? defaultMimeType,
            fileName: options.filenameHint ?? defaultFileName,
            sourceKind: "arraybuffer"
        };
    }

    if (isNodeReadableStream(source)) {
        return {
            bytes: await readNodeReadableStreamToUint8Array(
                source,
                options.signal,
                options.streamAbortMessage ?? "Request aborted while reading stream input"
            ),
            mimeType: options.mimeTypeHint ?? defaultMimeType,
            fileName: options.filenameHint ?? defaultFileName,
            sourceKind: "stream"
        };
    }

    throw new Error(options.unsupportedSourceMessage ?? "Unsupported input source");
}

/**
 * Normalizes a byte-backed input source into base64 plus best-effort metadata.
 *
 * @param {unknown} source - Byte-backed caller input.
 * @param {ResolveBinarySourceOptions} options - Optional resolution controls.
 * @returns {Promise<Omit<ResolvedBinarySource, "bytes"> & { base64: string }>} Base64 payload plus MIME type and filename.
 * @throws {Error} When the input cannot be normalized by `resolveBinarySource(...)`.
 */
export async function resolveBinarySourceToBase64(
    source: unknown,
    options: ResolveBinarySourceOptions = {}
): Promise<Omit<ResolvedBinarySource, "bytes"> & { base64: string }> {
    const resolved = await resolveBinarySource(source, options);
    return {
        ...resolved,
        base64: Buffer.from(resolved.bytes).toString("base64")
    };
}

/**
 * Normalizes a reference-media input that may arrive as raw base64, Data URI, or remote URL.
 *
 * @param {{ base64?: string; url?: string; mimeType?: string }} source - Reference media input with `base64`, `url`, and optional `mimeType`.
 * @param {string} defaultMimeType - Fallback MIME type.
 * @param {string} errorMessage - Error used when no usable media source is present.
 * @returns {ResolvedReferenceMediaSource} Base64 or remote URL representation with MIME type.
 * @throws {Error} When neither `base64` nor `url` is present.
 */
export function resolveReferenceMediaSource(
    source: { base64?: string; url?: string; mimeType?: string },
    defaultMimeType = "image/png",
    errorMessage = "Reference media input requires base64 or url"
): ResolvedReferenceMediaSource {
    const mimeType = source.mimeType ?? defaultMimeType;

    if (typeof source.base64 === "string" && source.base64.length > 0) {
        return {
            kind: "base64",
            mimeType,
            base64: stripDataUriPrefix(source.base64)
        };
    }

    if (typeof source.url === "string" && source.url.length > 0) {
        if (source.url.startsWith("data:")) {
            const parsed = parseDataUri(source.url);
            return {
                kind: "base64",
                mimeType: parsed.mimeType ?? mimeType,
                base64: Buffer.from(parsed.bytes).toString("base64")
            };
        }

        return {
            kind: "url",
            mimeType,
            url: source.url
        };
    }

    throw new Error(errorMessage);
}

/**
 * Normalizes a reference-media input into a provider-ready URL field.
 *
 * Providers like OpenAI and Mistral accept either remote URLs or Data URIs for
 * media parts. This helper preserves remote URLs and upgrades base64 inputs into
 * Data URIs with a best-effort MIME type.
 *
 * @param {{ base64?: string; url?: string; mimeType?: string }} source - Reference media input with `url`, `base64`, and optional `mimeType`.
 * @param {string} defaultMimeType - Fallback MIME type for base64 inputs.
 * @param {string} errorMessage - Error used when no usable media source is present.
 * @returns {string} Remote URL or Data URI string.
 * @throws {Error} When neither `base64` nor `url` is present.
 */
export function resolveReferenceMediaUrl(
    source: { base64?: string; url?: string; mimeType?: string },
    defaultMimeType = "application/octet-stream",
    errorMessage = "Reference media input requires base64 or url"
): string {
    if (typeof source.url === "string" && source.url.length > 0) {
        return source.url;
    }

    if (typeof source.base64 === "string" && source.base64.length > 0) {
        return ensureDataUri(source.base64, source.mimeType ?? defaultMimeType);
    }

    throw new Error(errorMessage);
}
