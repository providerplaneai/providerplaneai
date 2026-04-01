/**
 * @module providers/mistral/capabilities/shared/MistralFileUtils.ts
 * @description Shared file/source helpers for Mistral capability adapters.
 */
import type { FileT } from "@mistralai/mistralai/models/components";
import {
    dataUriToUint8Array,
    extractBlobName,
    fileNameFromPath,
    isNodeReadableStream,
    readFileToUint8Array,
    readNodeReadableStreamToUint8Array
} from "#root/index.js";

export type ResolveMistralFileInputOptions = {
    filenameHint?: string;
    mimeTypeHint?: string;
    defaultFileName: string;
    signal?: AbortSignal;
    fileAbortMessage: string;
    streamAbortMessage: string;
    unsupportedSourceMessage: string;
};

/**
 * Converts byte-backed caller inputs into Mistral `FileT` payloads.
 *
 * Remote URLs are intentionally not handled here because Mistral capabilities
 * route those through provider-specific `fileUrl`/`image_url`/`document_url`
 * request fields before falling back to uploaded file payloads.
 *
 * @param {unknown} source - Caller input source.
 * @param {ResolveMistralFileInputOptions} options - Resolution controls and error messages.
 * @returns {Promise<FileT>} Mistral file payload.
 * @throws {Error} When the source shape is unsupported.
 */
export async function resolveMistralFileInput(source: unknown, options: ResolveMistralFileInputOptions): Promise<FileT> {
    if (typeof source === "string") {
        if (/^data:/i.test(source)) {
            return {
                fileName: options.filenameHint ?? options.defaultFileName,
                content: dataUriToUint8Array(source)
            };
        }

        const bytes = await readFileToUint8Array(source, options.signal, options.fileAbortMessage);

        return {
            fileName: options.filenameHint ?? fileNameFromPath(source, options.defaultFileName),
            content:
                options.mimeTypeHint && typeof Blob !== "undefined"
                    ? new Blob([Buffer.from(bytes)], {
                          type: options.mimeTypeHint
                      })
                    : bytes
        };
    }

    if (typeof Blob !== "undefined" && source instanceof Blob) {
        return {
            fileName: options.filenameHint ?? extractBlobName(source) ?? options.defaultFileName,
            content: options.mimeTypeHint && !source.type ? new Blob([source], { type: options.mimeTypeHint }) : source
        };
    }

    if (typeof Buffer !== "undefined" && Buffer.isBuffer(source)) {
        return {
            fileName: options.filenameHint ?? options.defaultFileName,
            content: new Uint8Array(source)
        };
    }

    if (source instanceof Uint8Array) {
        return {
            fileName: options.filenameHint ?? options.defaultFileName,
            content: source
        };
    }

    if (source instanceof ArrayBuffer) {
        return {
            fileName: options.filenameHint ?? options.defaultFileName,
            content: new Uint8Array(source)
        };
    }

    if (isNodeReadableStream(source)) {
        return {
            fileName: options.filenameHint ?? options.defaultFileName,
            content: await readNodeReadableStreamToUint8Array(source, options.signal, options.streamAbortMessage)
        };
    }

    throw new Error(options.unsupportedSourceMessage);
}
