import { ClientRequestBase } from "#root/index.js";

/**
 * Request payload for embedding generation.
 *
 * - `input`: Single string or array of strings to embed.
 */
export interface ClientEmbeddingRequest extends ClientRequestBase {
    input: string | string[];
}
