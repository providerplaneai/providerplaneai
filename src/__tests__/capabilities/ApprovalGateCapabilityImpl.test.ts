import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
    createApprovalGateExecutor,
    createFileApprovalGateDecisionResolver,
    MultiModalExecutionContext
} from "#root/index.js";

describe("ApprovalGateCapabilityImpl", () => {
    let tempDir = "";

    beforeEach(async () => {
        tempDir = await mkdtemp(path.join(os.tmpdir(), "ppai-approval-"));
    });

    afterEach(async () => {
        if (tempDir) {
            await rm(tempDir, { recursive: true, force: true });
        }
    });

    it("returns normalized output for approved decision", async () => {
        const exec = createApprovalGateExecutor();
        const ctx = new MultiModalExecutionContext();

        const result = await exec.invoke(
            {} as any,
            {
                input: {
                    requestedAt: "2026-03-09T00:00:00.000Z",
                    decision: {
                        status: "approved",
                        reason: "ship it",
                        approver: "alice"
                    }
                }
            },
            ctx
        );

        expect(result.output.status).toBe("approved");
        expect(result.output.reason).toBe("ship it");
        expect(result.output.approver).toBe("alice");
        expect(result.output.requestedAt).toBe("2026-03-09T00:00:00.000Z");
        expect(typeof result.output.decidedAt).toBe("string");
    });

    it("supports rejected and timeout decisions", async () => {
        const exec = createApprovalGateExecutor();
        const ctx = new MultiModalExecutionContext();

        const rejected = await exec.invoke(
            {} as any,
            { input: { decision: { status: "rejected", reason: "needs edits" } } },
            ctx
        );
        const timeout = await exec.invoke(
            {} as any,
            { input: { decision: { status: "timeout", reason: "no response" } } },
            ctx
        );

        expect(rejected.output.status).toBe("rejected");
        expect(timeout.output.status).toBe("timeout");
    });

    it("throws ApprovalPendingError when decision is missing", async () => {
        const exec = createApprovalGateExecutor();
        const ctx = new MultiModalExecutionContext();

        await expect(exec.invoke({} as any, { input: {} }, ctx)).rejects.toMatchObject({
            name: "ApprovalPendingError"
        });
    });

    it("uses request-level pendingErrorMessage override", async () => {
        const exec = createApprovalGateExecutor();
        const ctx = new MultiModalExecutionContext();

        await expect(
            exec.invoke(
                {} as any,
                {
                    input: {
                        pendingErrorMessage: "decision file not present yet"
                    }
                },
                ctx
            )
        ).rejects.toThrow("decision file not present yet");
    });

    it("throws for invalid status", async () => {
        const exec = createApprovalGateExecutor();
        const ctx = new MultiModalExecutionContext();

        await expect(
            exec.invoke(
                {} as any,
                {
                    input: {
                        decision: {
                            status: "maybe"
                        }
                    }
                },
                ctx
            )
        ).rejects.toThrow("Invalid approval status 'maybe'");
    });

    it("uses request-level defaultApprover when approver is missing", async () => {
        const exec = createApprovalGateExecutor();
        const ctx = new MultiModalExecutionContext();

        const result = await exec.invoke(
            {} as any,
            {
                input: {
                    defaultApprover: "ops-team",
                    decision: { status: "approved" }
                }
            },
            ctx
        );

        expect(result.output.approver).toBe("ops-team");
    });

    it("file resolver loads a valid decision JSON", async () => {
        const filePath = path.join(tempDir, "approval.json");
        await writeFile(
            filePath,
            JSON.stringify({ status: "approved", reason: "ok", approver: "bot" }),
            "utf8"
        );

        const resolveDecision = createFileApprovalGateDecisionResolver(filePath);
        const decision = await resolveDecision({ input: {} });
        expect(decision).toEqual({ status: "approved", reason: "ok", approver: "bot" });
    });
});
