import { readFile } from "node:fs/promises";
import { WorkflowError, type AIClient, type AIRequest, type AIResponse, type NonStreamingExecutor } from "#root/index.js";

export const DEFAULT_APPROVAL_GATE_CAPABILITY_KEY = "approvalGate";

export type ApprovalGateStatus = "approved" | "rejected" | "timeout";

export interface ApprovalGateDecision {
    status?: string;
    reason?: string;
    approver?: string;
    decidedAt?: string;
}

export interface ApprovalGateRequestInput {
    requestedAt?: string;
    decision?: ApprovalGateDecision;
    pendingErrorMessage?: string;
    defaultApprover?: string;
}

export type ApprovalGateRequest = AIRequest<ApprovalGateRequestInput>;

export interface ApprovalGateOutput {
    status: ApprovalGateStatus;
    reason: string;
    approver: string;
    requestedAt: string;
    decidedAt: string;
}

export interface RegisterApprovalGateOptions {
    capabilityKey?: string;
    pendingErrorMessage?: string;
    defaultApprover?: string;
    resolveDecision?: (request: ApprovalGateRequest) => Promise<ApprovalGateDecision | undefined>;
}

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
 */
export function registerApprovalGateCapability(
    client: AIClient,
    options?: RegisterApprovalGateOptions
): { capabilityKey: string } {
    const capabilityKey = options?.capabilityKey ?? DEFAULT_APPROVAL_GATE_CAPABILITY_KEY;
    client.registerCapabilityExecutor(capabilityKey as any, createApprovalGateExecutor(options, capabilityKey));
    return { capabilityKey };
}

export function createApprovalGateExecutor(
    options?: RegisterApprovalGateOptions,
    capabilityKey: string = DEFAULT_APPROVAL_GATE_CAPABILITY_KEY
): NonStreamingExecutor<any, ApprovalGateRequestInput, ApprovalGateOutput> {
    return {
        streaming: false,
        async invoke(_provider, request: AIRequest<ApprovalGateRequestInput>): Promise<AIResponse<ApprovalGateOutput>> {
            const defaultApprover = String(request?.input?.defaultApprover ?? options?.defaultApprover ?? "unknown");
            const pendingErrorMessage = String(
                request?.input?.pendingErrorMessage ??
                    options?.pendingErrorMessage ??
                    "Approval decision missing. Provide a decision with status approved|rejected|timeout."
            );
            const decision =
                (typeof options?.resolveDecision === "function" ? await options.resolveDecision(request) : undefined) ??
                request?.input?.decision;

            if (!decision || typeof decision !== "object") {
                const pendingError = new WorkflowError(pendingErrorMessage);
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
