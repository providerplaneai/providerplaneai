/**
 * @module client/types/embeddings/ClientEmbeddingRequest.ts
 * @description ProviderPlaneAI source module.
 */
import { ClientRequestBase } from "#root/index.js";

/**
 * Request payload for embedding generation.
 *
 */
/**
 * @public
 * @description Interface contract for ClientEmbeddingRequest.
 */
export interface ClientEmbeddingRequest extends ClientRequestBase {
    input: string | string[];
    /**
     * Optional identifier for this embedding input
     */
    inputId?: string;
    /**
     * Optional semantic hint about the embedding (e.g., "query", "document")
     */
    purpose?: string;
}
