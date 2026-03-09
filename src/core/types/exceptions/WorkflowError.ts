/**
 * @module core/types/exceptions/WorkflowError.ts
 * @description Core shared type definitions used by runtime, providers, and workflows.
 */
/**
 * Thrown when a workflow execution encounters an error
 * This is a general error type for workflow-related issues,
 * and may wrap more specific errors like AllProvidersFailedError or ExecutionPolicyError.
 */
/**
 * @public
 * @description Implementation class for WorkflowError.
 */
export class WorkflowError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "WorkflowError";
    }
}
