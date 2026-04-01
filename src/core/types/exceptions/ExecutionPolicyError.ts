/**
 * @module core/types/exceptions/ExecutionPolicyError.ts
 * @description Error type used for execution policy violations and misconfiguration.
 */
/**
 * Thrown when an execution policy is violated or misconfigured.
 */
/**
 * @public
 * Error thrown when an execution policy is violated or misconfigured.
 */
export class ExecutionPolicyError extends Error {
    /**
     * @param {string} message - Human-readable execution-policy failure reason.
     */
    constructor(message: string) {
        super(message);
        this.name = "ExecutionPolicyError";
    }
}
