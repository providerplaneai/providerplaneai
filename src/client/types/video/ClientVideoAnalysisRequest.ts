import { ClientRequestBase } from "#root/index.js";

/**
 * Request payload for video analysis.
 *
 * - `file`: Video file or blob to analyze.
 * - `prompt`: Optional prompt or instructions for analysis.
 */
export interface ClientVideoAnalysisRequest extends ClientRequestBase {
    file: File | Blob;
    prompt?: string;
}
