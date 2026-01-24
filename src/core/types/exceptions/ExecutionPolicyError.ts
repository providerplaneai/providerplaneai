/**
 * Thrown when an execution policy is violated or misconfigured.
 */
export class ExecutionPolicyError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "ExecutionPolicyError";
    }
}
