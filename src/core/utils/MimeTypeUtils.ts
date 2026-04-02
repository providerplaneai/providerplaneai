/**
 * @module core/utils/MimeTypeUtils.ts
 * @description Shared MIME type lookup and classification helpers.
 */

const FILE_EXTENSION_TO_MIME_TYPE: Readonly<Record<string, string>> = {
    aac: "audio/aac",
    csv: "text/csv",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    flac: "audio/flac",
    gif: "image/gif",
    heic: "image/heic",
    heif: "image/heif",
    html: "text/html",
    jpeg: "image/jpeg",
    jpg: "image/jpeg",
    json: "application/json",
    m4a: "audio/mp4",
    md: "text/markdown",
    mp3: "audio/mpeg",
    oga: "audio/ogg",
    ogg: "audio/ogg",
    odt: "application/vnd.oasis.opendocument.text",
    opus: "audio/opus",
    pdf: "application/pdf",
    pcm: "audio/pcm",
    png: "image/png",
    pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    rtf: "application/rtf",
    svg: "image/svg+xml",
    tif: "image/tiff",
    tiff: "image/tiff",
    txt: "text/plain",
    wav: "audio/wav",
    webm: "audio/webm",
    webp: "image/webp",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    xml: "application/xml"
};

/**
 * Resolves a MIME type from an extension, bare format token, or filename.
 *
 * @param {string | undefined} value - Extension, format token, or filename/path to inspect.
 * @param {string | undefined} fallback - Value to return when the extension is unknown.
 * @returns {string | undefined} The resolved MIME type when recognized, otherwise `fallback`.
 */
export function getMimeTypeForExtensionOrFormat(value?: string, fallback?: string): string | undefined {
    if (!value) {
        return fallback;
    }

    const normalized = value.trim().toLowerCase();
    if (!normalized) {
        return fallback;
    }

    const basename = normalized.split(/[\\/]/).pop() ?? normalized;
    const key = basename.startsWith(".")
        ? basename.slice(1)
        : basename.includes(".")
          ? basename.slice(basename.lastIndexOf(".") + 1)
          : basename;

    return FILE_EXTENSION_TO_MIME_TYPE[key] ?? fallback;
}

/**
 * Infers a MIME type from a filename or path.
 *
 * @param {string | undefined} filename - Filename or path whose extension should be inspected.
 * @param {string | undefined} fallback - Value to return when the extension is unknown.
 * @returns {string | undefined} The resolved MIME type when recognized, otherwise `fallback`.
 */
export function inferMimeTypeFromFilename(filename?: string, fallback?: string): string | undefined {
    return getMimeTypeForExtensionOrFormat(filename, fallback);
}

/**
 * Extracts the declared MIME type from a Data URI header.
 *
 * @param {string} dataUri - Data URI to inspect.
 * @returns {string | undefined} The embedded MIME type when present.
 */
export function extractDataUriMimeType(dataUri: string): string | undefined {
    const match = /^data:([^;,]+)[;,]/i.exec(dataUri);
    return match?.[1];
}

/**
 * Reports whether a MIME type represents image content.
 *
 * @param {string | undefined} mimeType - MIME type to classify.
 * @returns {boolean} `true` when the value is an image MIME type.
 */
export function isImageMimeType(mimeType?: string): boolean {
    return typeof mimeType === "string" && /^image\//i.test(mimeType);
}

/**
 * Reports whether a MIME type represents audio content.
 *
 * @param {string | undefined} mimeType - MIME type to classify.
 * @returns {boolean} `true` when the value is an audio MIME type.
 */
export function isAudioMimeType(mimeType?: string): boolean {
    return typeof mimeType === "string" && /^audio\//i.test(mimeType);
}

/**
 * Reports whether a MIME type represents video content.
 *
 * @param {string | undefined} mimeType - MIME type to classify.
 * @returns {boolean} `true` when the value is a video MIME type.
 */
export function isVideoMimeType(mimeType?: string): boolean {
    return typeof mimeType === "string" && /^video\//i.test(mimeType);
}

/**
 * Reports whether a MIME type represents a PDF document.
 *
 * @param {string | undefined} mimeType - MIME type to classify.
 * @returns {boolean} `true` when the value is exactly `application/pdf`.
 */
export function isPdfMimeType(mimeType?: string): boolean {
    return mimeType === "application/pdf";
}

/**
 * Performs a filename-based guess about whether a path refers to an image.
 *
 * @param {string} value - Filename or path to inspect.
 * @returns {boolean} `true` when the inferred MIME type is an image MIME type.
 */
export function isLikelyImagePath(value: string): boolean {
    return isImageMimeType(inferMimeTypeFromFilename(value));
}
