import { readFile } from "node:fs/promises";
import { WorkflowError, type AIClient, type AIRequest, type AIResponse, type NonStreamingExecutor } from "#root/index.js";

/**
 * Default capability key used when registering the approval gate capability.
 *
 * @public
 */
export const DEFAULT_APPROVAL_GATE_CAPABILITY_KEY = "approvalGate";

/**
 * Supported approval outcomes.
 *
 * @public
 */
export type ApprovalGateStatus = "approved" | "rejected" | "timeout";

/**
 * Decision payload used by the approval gate.
 *
 * @public
 */
export interface ApprovalGateDecision {
    status?: string;
    reason?: string;
    approver?: string;
    decidedAt?: string;
}

/**
 * Input shape for approval gate capability requests.
 *
 * @public
 */
export interface ApprovalGateRequestInput {
    requestedAt?: string;
    decision?: ApprovalGateDecision;
    pendingErrorMessage?: string;
    defaultApprover?: string;
}

/**
 * Typed request alias for approval gate operations.
 *
 * @public
 */
export type ApprovalGateRequest = AIRequest<ApprovalGateRequestInput>;

/**
 * Normalized approval decision emitted by the capability.
 *
 * @public
 */
export interface ApprovalGateOutput {
    status: ApprovalGateStatus;
    reason: string;
    approver: string;
    requestedAt: string;
    decidedAt: string;
}

/**
 * Configuration for registering approval gate capability.
 *
 * @public
 */
export interface RegisterApprovalGateOptions {
    capabilityKey?: string;
    pendingErrorMessage?: string;
    defaultApprover?: string;
    resolveDecision?: (request: ApprovalGateRequest) => Promise<ApprovalGateDecision | undefined>;
}

/**
 * Converts a raw decision payload into normalized output.
 *
 * @param decision Raw decision payload
 * @param status Normalized status
 * @param request Original capability request
 * @param defaults Default output values
 * @returns Normalized approval gate output
 * @private
 */
function normalizeDecision(
    decision: ApprovalGateDecision,
    status: ApprovalGateStatus,
    request: ApprovalGateRequest,
    defaults: {
        defaultApprover: string;
    }
): ApprovalGateOutput {
    return {
        status,
        reason: String(decision?.reason ?? ""),
        approver: String(decision?.approver ?? defaults.defaultApprover),
        requestedAt: String(request?.input?.requestedAt ?? ""),
        decidedAt: String(decision?.decidedAt ?? new Date().toISOString())
    };
}

/**
 * Registers a reusable approval-gate custom capability on AIClient.
 *
 * The capability expects `request.input.decision` by default, or a custom `resolveDecision`
 * function can supply decisions from external systems (file/db/api).
 *
 * @param client AI client where executor will be registered
 * @param options Optional registration and resolution settings
 * @returns Registered capability key
 * @public
 */
export function registerApprovalGateCapability(
    client: AIClient,
    options?: RegisterApprovalGateOptions
): { capabilityKey: string } {
    const capabilityKey = options?.capabilityKey ?? DEFAULT_APPROVAL_GATE_CAPABILITY_KEY;
    client.registerCapabilityExecutor(capabilityKey as any, createApprovalGateExecutor(options, capabilityKey));
    return { capabilityKey };
}

/**
 * Creates a non-streaming approval gate executor.
 *
 * @param options Optional registration and resolution settings
 * @param capabilityKey Capability key used in executor metadata/id
 * @returns Non-streaming approval gate executor
 * @public
 */
export function createApprovalGateExecutor(
    options?: RegisterApprovalGateOptions,
    capabilityKey: string = DEFAULT_APPROVAL_GATE_CAPABILITY_KEY
): NonStreamingExecutor<any, ApprovalGateRequestInput, ApprovalGateOutput> {
    return {
        streaming: false,
        async invoke(_provider, request: AIRequest<ApprovalGateRequestInput>): Promise<AIResponse<ApprovalGateOutput>> {
            // Per-request values override registration defaults for easier runtime wiring.
            const defaultApprover = String(request?.input?.defaultApprover ?? options?.defaultApprover ?? "unknown");
            const pendingErrorMessage = String(
                request?.input?.pendingErrorMessage ??
                    options?.pendingErrorMessage ??
                    "Approval decision missing. Provide a decision with status approved|rejected|timeout."
            );
            // Decision precedence:
            // 1) custom resolver (file/db/api)
            // 2) inline decision payload on request
            const decision =
                (typeof options?.resolveDecision === "function" ? await options.resolveDecision(request) : undefined) ??
                request?.input?.decision;

            if (!decision || typeof decision !== "object") {
                const pendingError = new WorkflowError(pendingErrorMessage);
                // Special name lets workflows distinguish pending manual approval vs hard failure.
                pendingError.name = "ApprovalPendingError";
                throw pendingError;
            }

            const status = String(decision.status ?? "").toLowerCase();
            if (status !== "approved" && status !== "rejected" && status !== "timeout") {
                throw new WorkflowError(`Invalid approval status '${status}'. Expected approved|rejected|timeout.`);
            }

            const output = normalizeDecision(decision, status as ApprovalGateStatus, request, { defaultApprover });

            return {
                output,
                rawResponse: decision,
                id: `${capabilityKey}-${Date.now()}`,
                metadata: { status: "completed", capabilityKey }
            };
        }
    };
}

/**
 * Creates a decision resolver that reads a JSON file from disk.
 *
 * File content example:
 * `{"status":"approved","reason":"looks good","approver":"alice"}`
 *
 * @param filePath Source decision file path
 * @returns Async resolver compatible with `RegisterApprovalGateOptions.resolveDecision`
 * @public
 */
export function createFileApprovalGateDecisionResolver(filePath: string) {
    return async (_request: ApprovalGateRequest): Promise<ApprovalGateDecision | undefined> => {
        try {
            const raw = await readFile(filePath, "utf8");
            const parsed = JSON.parse(raw) as ApprovalGateDecision;
            if (!parsed || typeof parsed !== "object") {
                return undefined;
            }
            return parsed;
        } catch {
            return undefined;
        }
    };
}
