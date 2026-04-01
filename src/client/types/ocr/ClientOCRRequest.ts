/**
 * @module client/types/ocr/ClientOCRRequest.ts
 * @description Provider-agnostic OCR request contracts.
 */
import { ClientFileInputSource, ClientReferenceImage, ClientRequestBase } from "#root/index.js";

/**
 * Structured annotation modes supported by OCR/document processors that can return
 * machine-readable extraction results in addition to plain text.
 *
 * @public
 */
export type ClientOCRAnnotationMode = "document" | "regions";

/**
 * Table serialization formats supported by OCR/document processors.
 *
 * @public
 */
export type ClientOCRTableFormat = "inline" | "markdown" | "html";

/**
 * Provider-agnostic JSON schema descriptor for structured OCR annotations.
 *
 * @public
 */
export interface ClientOCRAnnotationSchema {
    /**
     * Stable schema name required by providers that expose schema-enforced output modes.
     */
    name: string;

    /**
     * Optional human-readable schema description.
     */
    description?: string;

    /**
     * JSON Schema definition for the expected OCR annotation payload.
     */
    schema: Record<string, unknown>;

    /**
     * Whether the provider should enforce strict adherence to the schema.
     */
    strict?: boolean;
}

/**
 * Optional structured OCR extraction settings used by providers with richer
 * document understanding APIs.
 *
 * @public
 */
export interface ClientOCRStructuredOptions {
    /**
     * Structured annotation mode requested from the provider.
     */
    annotationMode?: ClientOCRAnnotationMode;

    /**
     * Prompt describing which annotations should be extracted.
     *
     * Some providers require `annotationFormat` to be set when this field is used.
     */
    annotationPrompt?: string;

    /**
     * Structured schema required by providers that support schema-constrained
     * annotation extraction.
     */
    annotationSchema?: ClientOCRAnnotationSchema;

    /**
     * Preferred table serialization format when table extraction is available.
     */
    tableFormat?: ClientOCRTableFormat;

    /**
     * Whether document headers should be extracted when the provider supports it.
     */
    extractHeaders?: boolean;

    /**
     * Whether document footers should be extracted when the provider supports it.
     */
    extractFooters?: boolean;

    /**
     * Optional one-based page numbers to process.
     */
    pages?: number[];
}

/**
 * Request payload for OCR and document extraction operations.
 *
 * @public
 */
export interface ClientOCRRequest extends ClientRequestBase {
    /**
     * One or more images to process with OCR.
     */
    images?: ClientReferenceImage[];

    /**
     * Optional document or file source to process with OCR.
     *
     * This can be a local path, URL string, bytes, blob, file, or readable stream.
     */
    file?: ClientFileInputSource;

    /**
     * Optional filename hint when `file` is bytes or a stream.
     */
    filename?: string;

    /**
     * Optional MIME type hint for the supplied `file`.
     */
    mimeType?: string;

    /**
     * Optional instruction to guide OCR behavior.
     * Example: "Preserve line breaks and headings."
     */
    prompt?: string;

    /**
     * Optional language hint for the document or image text.
     */
    language?: string;

    /**
     * Whether the caller prefers region-aware OCR output when supported.
     */
    includeBoundingBoxes?: boolean;

    /**
     * Optional advanced structured extraction controls.
     */
    structured?: ClientOCRStructuredOptions;

    /**
     * Provider escape hatch for OCR-specific request parameters.
     */
    extras?: Record<string, unknown>;
}
