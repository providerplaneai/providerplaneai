/**
 * Thrown when a workflow execution encounters an error
 * This is a general error type for workflow-related issues,
 * and may wrap more specific errors like AllProvidersFailedError or ExecutionPolicyError.
 */
export class WorkflowError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "WorkflowError";
    }
}
