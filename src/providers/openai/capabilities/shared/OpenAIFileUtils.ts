/**
 * @module providers/openai/capabilities/shared/OpenAIFileUtils.ts
 * @description Shared file/source helpers for OpenAI capability adapters.
 */
import { toFile } from "openai/uploads";
import {
    fileNameFromPath,
    isBlobLike,
    parseDataUriToBuffer,
    pathExists,
    readFileToBuffer,
    resolveReferenceMediaSource
} from "#root/index.js";

/**
 * Converts supported byte-backed inputs into an OpenAI SDK uploadable file object.
 *
 * String inputs must be either Data URIs or local file paths. Stream-like values
 * are passed through to `toFile(...)` so the OpenAI SDK can handle them directly.
 *
 * @param {unknown} source - Input source to normalize.
 * @param {string | undefined} filenameHint - Optional upload filename hint.
 * @param {string | undefined} mimeTypeHint - Optional MIME type hint.
 * @param {string} defaultFileName - Fallback filename when none can be inferred.
 * @param {string} invalidStringMessage - Error used when a string input is neither a data URI nor a local file path.
 * @returns {Promise<unknown>} OpenAI SDK uploadable file object.
 */
export async function toOpenAIUploadableFile(
    source: unknown,
    filenameHint?: string,
    mimeTypeHint?: string,
    defaultFileName = "input",
    invalidStringMessage = "String input must be a data URL or local file path"
) {
    if (isBlobLike(source)) {
        const fileName = filenameHint ?? defaultFileName;
        return await toFile(source as any, fileName, mimeTypeHint ? { type: mimeTypeHint } : undefined);
    }

    if (typeof Buffer !== "undefined" && Buffer.isBuffer(source)) {
        const fileName = filenameHint ?? defaultFileName;
        return await toFile(source, fileName, mimeTypeHint ? { type: mimeTypeHint } : undefined);
    }

    if (source instanceof Uint8Array) {
        const fileName = filenameHint ?? defaultFileName;
        return await toFile(Buffer.from(source), fileName, mimeTypeHint ? { type: mimeTypeHint } : undefined);
    }

    if (source instanceof ArrayBuffer) {
        const fileName = filenameHint ?? defaultFileName;
        return await toFile(Buffer.from(source), fileName, mimeTypeHint ? { type: mimeTypeHint } : undefined);
    }

    if (typeof source === "string") {
        if (source.startsWith("data:")) {
            const parsed = parseDataUriToBuffer(source);
            const fileName = filenameHint ?? defaultFileName;
            return await toFile(parsed.bytes, fileName, { type: mimeTypeHint ?? parsed.mimeType });
        }

        if (await pathExists(source)) {
            const bytes = await readFileToBuffer(source);
            const fileName = filenameHint ?? fileNameFromPath(source, defaultFileName);
            return await toFile(bytes, fileName, mimeTypeHint ? { type: mimeTypeHint } : undefined);
        }

        throw new Error(invalidStringMessage);
    }

    const fileName = filenameHint ?? defaultFileName;
    return await toFile(source as any, fileName, mimeTypeHint ? { type: mimeTypeHint } : undefined);
}

/**
 * Converts a base64/Data-URI reference image into an OpenAI uploadable file.
 *
 * OpenAI video `input_reference` requires uploaded image content rather than a
 * remote URL. This helper preserves that provider contract while centralizing
 * the base64/Data URI normalization.
 *
 * @param {{ base64?: string; url?: string; mimeType?: string } | undefined} referenceImage - Reference image input with `base64`, `url`, and optional `mimeType`.
 * @param {string} defaultFileName - Fallback filename.
 * @param {string} invalidUrlMessage - Error used when a remote URL is provided.
 * @param {string} missingSourceMessage - Error used when no source is provided.
 * @returns {Promise<unknown | undefined>} OpenAI SDK uploadable file object.
 * @throws {Error} When a remote URL is provided instead of uploadable image content.
 */
export async function toOpenAIReferenceImageFile(
    referenceImage: { base64?: string; url?: string; mimeType?: string } | undefined,
    defaultFileName = "reference-image.png",
    invalidUrlMessage = "OpenAI reference image requires uploaded image content",
    missingSourceMessage = "referenceImage must include either base64 data or be omitted"
) {
    if (!referenceImage) {
        return undefined;
    }

    const resolved = resolveReferenceMediaSource(referenceImage, "image/png", missingSourceMessage);
    if (resolved.kind !== "base64") {
        throw new Error(invalidUrlMessage);
    }

    return await toFile(Buffer.from(resolved.base64, "base64"), defaultFileName, { type: resolved.mimeType });
}
