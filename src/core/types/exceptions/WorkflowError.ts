/**
 * @module core/types/exceptions/WorkflowError.ts
 * @description Error type used for workflow execution/runtime failures.
 */

/**
 * Error thrown when workflow construction, scheduling, or execution fails.
 *
 * @public
 * @remarks
 * This is the generic workflow-domain error type and may be thrown directly
 * by workflow runtime internals when a more specific domain exception is not used.
 *
 * @param {string} message Human-readable workflow failure reason.
 */
export class WorkflowError extends Error {
    /**
     * Creates a new workflow error instance.
     *
     * @param {string} message Human-readable workflow failure reason.
     * @returns {void}
     */
    constructor(message: string) {
        super(message);
        this.name = "WorkflowError";
    }
}
