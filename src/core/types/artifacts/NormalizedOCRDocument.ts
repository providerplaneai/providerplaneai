/**
 * @module core/types/artifacts/NormalizedOCRDocument.ts
 * @description Normalized OCR document, page, table, and annotation contracts.
 */
import { BoundingBox, NormalizedArtifactBase, OCRText } from "#root/index.js";

/**
 * Structured OCR annotation extracted from a document or image.
 *
 * @public
 */
export interface NormalizedOCRAnnotation {
    /**
     * Annotation style emitted by the provider.
     */
    type: "document" | "bbox";

    /**
     * Optional provider- or prompt-defined label for the annotation.
     */
    label?: string;

    /**
     * Extracted text associated with the annotation.
     */
    text?: string;

    /**
     * Parsed structured annotation payload when the provider returns machine-readable
     * JSON content instead of only free-form text.
     */
    data?: Record<string, unknown> | unknown[];

    /**
     * Optional normalized bounding box when the provider emits region geometry.
     */
    bbox?: BoundingBox;

    /**
     * One-based page number when available.
     */
    pageNumber?: number;

    /**
     * Provider-specific annotation metadata preserved for advanced consumers.
     */
    metadata?: Record<string, unknown>;
}

/**
 * Structured OCR table extracted from a document or image.
 *
 * @public
 */
export interface NormalizedOCRTable {
    /**
     * One-based page number when available.
     */
    pageNumber?: number;

    /**
     * Serialization format of the table content.
     */
    format: "markdown" | "html";

    /**
     * Serialized table body.
     */
    content: string;
}

/**
 * Header/footer text captured during OCR processing.
 *
 * @public
 */
export interface NormalizedOCRPageSection {
    /**
     * One-based page number when available.
     */
    pageNumber?: number;

    /**
     * Extracted section text.
     */
    text: string;
}

/**
 * OCR content extracted from a single page.
 */
/**
 * @public
 * OCR content extracted from a single page.
 */
export interface NormalizedOCRPage {
    /**
     * One-based page number when available.
     */
    pageNumber: number;

    /**
     * Full plain-text page content when available.
     */
    fullText?: string;

    /**
     * Region-aware OCR text spans when available.
     */
    text?: OCRText[];

    /**
     * Optional provider-specific metadata for the page.
     */
    metadata?: Record<string, unknown>;
}

/**
 * Provider-agnostic OCR/document extraction result.
 */
/**
 * @public
 * Provider-agnostic OCR or document-extraction artifact.
 */
export interface NormalizedOCRDocument extends NormalizedArtifactBase {
    /**
     * Full plain-text document content when available.
     */
    fullText?: string;

    /**
     * Flat OCR text spans for single-page or non-paginated outputs.
     */
    text?: OCRText[];

    /**
     * Optional page-aware OCR output.
     */
    pages?: NormalizedOCRPage[];

    /**
     * Optional detected language for the OCR result.
     */
    language?: string;

    /**
     * Optional page count when available.
     */
    pageCount?: number;

    /**
     * Optional source file name when available.
     */
    fileName?: string;

    /**
     * Optional source mime type when available.
     */
    mimeType?: string;

    /**
     * Optional source image identifier when OCR is image-based.
     */
    sourceImageId?: string;

    /**
     * Optional structured annotations emitted by richer OCR/document processors.
     */
    annotations?: NormalizedOCRAnnotation[];

    /**
     * Optional structured table payloads emitted during OCR.
     */
    tables?: NormalizedOCRTable[];

    /**
     * Optional extracted page headers.
     */
    headers?: NormalizedOCRPageSection[];

    /**
     * Optional extracted page footers.
     */
    footers?: NormalizedOCRPageSection[];

    /**
     * Optional raw provider markdown/text representation preserved for advanced
     * document-processing use cases.
     */
    rawDocumentMarkdown?: string;
}
