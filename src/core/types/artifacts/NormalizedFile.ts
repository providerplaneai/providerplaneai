import { NormalizedArtifactBase } from "#root/index.js";

/**
 * Normalized representation of any file output produced by a provider.
 *
 * Examples:
 * - Generated PDFs
 * - CSVs
 * - JSON outputs
 * - Tool-generated artifacts
 */
export interface NormalizedFile extends NormalizedArtifactBase {

    /** Original filename if provided */
    filename?: string;

    /** MIME type (e.g. application/pdf, text/csv) */
    mimeType: string;

    /** Public or signed URL to the file */
    url?: string;

    /** Base64-encoded file data */
    base64?: string;

    /** File size in bytes */
    sizeBytes?: number;
}
