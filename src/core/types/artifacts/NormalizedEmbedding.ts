import { NormalizedArtifactBase } from "#root/index.js";

/**
 * Canonical, provider-agnostic embedding artifact.
 * Stored in the execution context timeline.
 */
export interface NormalizedEmbedding extends NormalizedArtifactBase {
    /**
     * The embedding vector(s).
     *
     * - Single vector for typical use
     * - Multiple vectors if the provider returned batched embeddings
     */
    vector: number[] | number[][];

    /**
     * Dimensionality of the embedding vector.
     * Useful for validation and downstream tooling.
     */
    dimensions: number;

    /**
     * Optional identifier for what was embedded.
     * NOT required to reconstruct provider requests.
     */
    inputId?: string;

    /**
     * Optional semantic hint about what the embedding represents.
     * Example: "document", "query", "code", "image-caption"
     */
    purpose?: string;
}
