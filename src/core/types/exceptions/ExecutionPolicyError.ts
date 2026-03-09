/**
 * @module core/types/exceptions/ExecutionPolicyError.ts
 * @description Core shared type definitions used by runtime, providers, and workflows.
 */
/**
 * Thrown when an execution policy is violated or misconfigured.
 */
/**
 * @public
 * @description Implementation class for ExecutionPolicyError.
 */
export class ExecutionPolicyError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "ExecutionPolicyError";
    }
}
