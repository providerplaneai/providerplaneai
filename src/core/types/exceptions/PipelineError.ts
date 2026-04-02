/**
 * @module core/types/exceptions/PipelineError
 * @description Error type used for pipeline authoring and resolution failures.
 */

/**
 * Error thrown when a pipeline step cannot be resolved or constructed safely.
 *
 * @public
 * @param {string} message Human-readable pipeline failure reason.
 */
export class PipelineError extends Error {
    /**
     * Creates a new pipeline error instance.
     *
     * @param {string} message Human-readable pipeline failure reason.
     */
    constructor(message: string) {
        super(message);
        this.name = "PipelineError";
    }
}
