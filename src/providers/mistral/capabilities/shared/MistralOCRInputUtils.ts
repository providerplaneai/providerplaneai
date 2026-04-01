/**
 * @module providers/mistral/capabilities/shared/MistralOCRInputUtils.ts
 * @description Shared Mistral OCR input-routing helpers.
 */
import type { FileT } from "@mistralai/mistralai/models/components";
import {
    ClientFileInputSource,
    ClientOCRRequest,
    ClientReferenceImage,
    dataUriToUint8Array,
    extractDataUriMimeType,
    fileNameFromPath,
    isImageMimeType as isGenericImageMimeType,
    resolveReferenceMediaUrl,
    resolveMistralFileInput
} from "#root/index.js";

export type MistralOCRFormatSupportLevel = "documented" | "tested" | "experimental";
export type MistralOCRTransportClass = "image" | "document";

export type MistralOCRFormatDescriptor = {
    extension: string;
    mimeType: string;
    transport: MistralOCRTransportClass;
    supportLevel: MistralOCRFormatSupportLevel;
};

export type MistralOCRDocumentInput =
    | { type: "image_url"; imageUrl: string }
    | { type: "document_url"; documentUrl: string; documentName?: string }
    | { type: "file"; fileId: string };

/**
 * Known Mistral OCR format buckets grouped by observed support level.
 *
 * `tested` reflects formats exercised in this project, `documented` reflects provider documentation,
 * and `experimental` captures additional formats that may work but are not relied on.
 */
export const MISTRAL_OCR_FORMATS = {
    tested: [
        { extension: "png", mimeType: "image/png", transport: "image", supportLevel: "tested" },
        { extension: "jpg", mimeType: "image/jpeg", transport: "image", supportLevel: "tested" },
        { extension: "jpeg", mimeType: "image/jpeg", transport: "image", supportLevel: "tested" },
        { extension: "webp", mimeType: "image/webp", transport: "image", supportLevel: "tested" },
        { extension: "gif", mimeType: "image/gif", transport: "image", supportLevel: "tested" },
        { extension: "bmp", mimeType: "image/bmp", transport: "image", supportLevel: "tested" },
        { extension: "tiff", mimeType: "image/tiff", transport: "image", supportLevel: "tested" },
        { extension: "heic", mimeType: "image/heic", transport: "image", supportLevel: "tested" },
        { extension: "heif", mimeType: "image/heif", transport: "image", supportLevel: "tested" },
        { extension: "avif", mimeType: "image/avif", transport: "image", supportLevel: "tested" },
        { extension: "pdf", mimeType: "application/pdf", transport: "document", supportLevel: "tested" },        
        {
            extension: "docx",
            mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            transport: "document",
            supportLevel: "tested"
        },
        {
            extension: "pptx",
            mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
            transport: "document",
            supportLevel: "tested"
        },
        {
            extension: "odt",
            mimeType: "application/vnd.oasis.opendocument.text",
            transport: "document",
            supportLevel: "tested"
        },
        {
            extension: "xlsx",
            mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            transport: "document",
            supportLevel: "tested"
        }
    ],
    documented: [],
    experimental: [
        { extension: "jpe", mimeType: "image/jpeg", transport: "image", supportLevel: "experimental" },
        { extension: "jfif", mimeType: "image/jpeg", transport: "image", supportLevel: "experimental" },
        { extension: "tif", mimeType: "image/tiff", transport: "image", supportLevel: "experimental" },
        { extension: "rtf", mimeType: "application/rtf", transport: "document", supportLevel: "experimental" }
    ]
} as const satisfies Record<MistralOCRFormatSupportLevel, readonly MistralOCRFormatDescriptor[]>;

const MISTRAL_OCR_FORMAT_LIST = [
    ...MISTRAL_OCR_FORMATS.tested,
    ...MISTRAL_OCR_FORMATS.documented,
    ...MISTRAL_OCR_FORMATS.experimental
] as const satisfies readonly MistralOCRFormatDescriptor[];

const MISTRAL_OCR_EXTENSION_TO_FORMAT = new Map<string, MistralOCRFormatDescriptor>(
    MISTRAL_OCR_FORMAT_LIST.map((format) => [format.extension, format] satisfies [string, MistralOCRFormatDescriptor])
);
const MISTRAL_OCR_MIME_TO_FORMAT = new Map<string, MistralOCRFormatDescriptor>(
    MISTRAL_OCR_FORMAT_LIST.map((format) => [format.mimeType, format] satisfies [string, MistralOCRFormatDescriptor])
);

/**
 * Resolves the provider-specific OCR input payload for a Mistral OCR request.
 *
 * @param {ClientOCRRequest} input - Unified OCR request input.
 * @param {{ signal?: AbortSignal; defaultFileName: string; uploadFile: (file: FileT, signal?: AbortSignal) => Promise<MistralOCRDocumentInput>; }} options - Upload and resolution controls.
 * @returns {Promise<MistralOCRDocumentInput>} Mistral OCR input payload.
 * @throws {Error} When neither an image nor file source is provided.
 */
export function resolveMistralOCRDocumentInput(
    input: ClientOCRRequest,
    options: {
        signal?: AbortSignal;
        defaultFileName: string;
        uploadFile: (file: FileT, signal?: AbortSignal) => Promise<MistralOCRDocumentInput>;
    }
): Promise<MistralOCRDocumentInput> {
    const image = input.images?.[0];
    if (image) {
        return Promise.resolve(toMistralImageChunk(image));
    }

    const file = input.file;
    if (file === undefined) {
        throw new Error("OCR requires a file or image input");
    }

    return toMistralDocumentChunk(file, input.filename, input.mimeType, options);
}

/**
 * Resolves the upload filename used for Mistral OCR file-backed inputs.
 *
 * @param {string | undefined} filename - Explicit filename supplied by the caller.
 * @param {string | undefined} mimeType - MIME type used to infer an extension when needed.
 * @param {string} defaultFileName - Fallback base filename.
 * @returns {string} Filename to use for the upload.
 */
export function resolveMistralOCRUploadFilename(filename?: string, mimeType?: string, defaultFileName = "ocr-input"): string {
    if (filename && filename.trim().length > 0) {
        return filename;
    }

    const extension = fileExtensionForMimeType(mimeType);
    return extension ? `${defaultFileName}.${extension}` : defaultFileName;
}

/**
 * Best-effort check for whether a remote URL should be routed through Mistral's image transport.
 *
 * @param {string} value - Remote URL to inspect.
 * @param {string | undefined} mimeType - Optional MIME type hint.
 * @returns {boolean} `true` when the URL should be treated as an image input.
 */
export function looksLikeMistralOCRImageUrl(value: string, mimeType?: string): boolean {
    if (isMistralOCRImageMimeType(mimeType)) {
        return true;
    }

    try {
        const pathname = new URL(value).pathname.toLowerCase();
        const extension = pathname.split(".").pop();
        return extension !== undefined && lookupFormatByExtension(extension)?.transport === "image";
    } catch {
        return false;
    }
}

/**
 * Reports whether a MIME type should be treated as an image by Mistral OCR routing.
 *
 * @param {string | undefined} mimeType - MIME type to inspect.
 * @returns {boolean} `true` when the MIME type should use image transport.
 */
export function isMistralOCRImageMimeType(mimeType?: string): boolean {
    if (typeof mimeType !== "string") {
        return false;
    }

    const normalizedMimeType = mimeType.toLowerCase();
    return lookupFormatByMimeType(normalizedMimeType)?.transport === "image" || isGenericImageMimeType(normalizedMimeType);
}

function toMistralImageChunk(image: ClientReferenceImage): MistralOCRDocumentInput {
    return {
        type: "image_url",
        imageUrl: resolveReferenceMediaUrl(image, "image/png", "Mistral OCR image inputs require either `url` or `base64`")
    };
}

async function toMistralDocumentChunk(
    file: ClientFileInputSource,
    filename: string | undefined,
    mimeType: string | undefined,
    options: {
        signal?: AbortSignal;
        defaultFileName: string;
        uploadFile: (file: FileT, signal?: AbortSignal) => Promise<MistralOCRDocumentInput>;
    }
): Promise<MistralOCRDocumentInput> {
    if (typeof file === "string") {
        const isRemoteUrl = /^https?:\/\//i.test(file);
        if (isRemoteUrl) {
            if (looksLikeMistralOCRImageUrl(file, mimeType)) {
                return { type: "image_url", imageUrl: file };
            }

            return {
                type: "document_url",
                documentUrl: file,
                ...(filename ? { documentName: filename } : {})
            };
        }

        const isDataUri = /^data:/i.test(file);
        if (isDataUri) {
            const dataUriMimeType = extractDataUriMimeType(file) ?? mimeType;
            if (isMistralOCRImageMimeType(dataUriMimeType)) {
                return { type: "image_url", imageUrl: file };
            }

            const fileName = resolveMistralOCRUploadFilename(filename, dataUriMimeType, options.defaultFileName);
            return options.uploadFile(
                {
                    fileName,
                    content: dataUriToUint8Array(file)
                },
                options.signal
            );
        }

        return options.uploadFile(
            await resolveMistralFileInput(file, {
                filenameHint: resolveMistralOCRUploadFilename(
                    filename ?? fileNameFromPath(file, options.defaultFileName),
                    mimeType,
                    options.defaultFileName
                ),
                mimeTypeHint: mimeType,
                defaultFileName: options.defaultFileName,
                signal: options.signal,
                fileAbortMessage: "OCR request aborted while reading file input",
                streamAbortMessage: "OCR request aborted while reading stream input",
                unsupportedSourceMessage: "Unsupported Mistral OCR input type"
            }),
            options.signal
        );
    }

    return options.uploadFile(
        await resolveMistralFileInput(file, {
            filenameHint: resolveMistralOCRUploadFilename(filename, mimeType, options.defaultFileName),
            mimeTypeHint: mimeType,
            defaultFileName: options.defaultFileName,
            signal: options.signal,
            fileAbortMessage: "OCR request aborted while reading file input",
            streamAbortMessage: "OCR request aborted while reading stream input",
            unsupportedSourceMessage: "Unsupported Mistral OCR input type"
        }),
        options.signal
    );
}

function fileExtensionForMimeType(mimeType?: string): string | undefined {
    return lookupFormatByMimeType((mimeType ?? "").toLowerCase())?.extension;
}

function lookupFormatByExtension(extension: string): MistralOCRFormatDescriptor | undefined {
    return MISTRAL_OCR_EXTENSION_TO_FORMAT.get(extension.toLowerCase());
}

function lookupFormatByMimeType(mimeType: string): MistralOCRFormatDescriptor | undefined {
    return MISTRAL_OCR_MIME_TO_FORMAT.get(mimeType.toLowerCase());
}
