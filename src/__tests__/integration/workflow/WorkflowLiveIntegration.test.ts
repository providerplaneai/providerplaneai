import { describe, expect, it } from "vitest";
import dotenv from "dotenv";
import { mkdtemp, readFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import {
    AIClient,
    AllProvidersFailedError,
    CapabilityKeys,
    GenericJob,
    JobManager,
    MultiModalExecutionContext,
    WorkflowBuilder,
    WorkflowRunner,
    createApprovalGateExecutor,
    createSaveFileExecutor,
    type ProviderRef
} from "#root/index.js";

dotenv.config({ quiet: true });

const RUN_WORKFLOW_LIVE_INTEGRATION = process.env.RUN_WORKFLOW_LIVE_INTEGRATION === "1";
const REQUIRED_ENV_VARS = ["OPENAI_API_KEY_1", "GEMINI_API_KEY_1", "ANTHROPIC_API_KEY_1"] as const;
const MISTRAL_REQUIRED_ENV_VARS = ["MISTRAL_API_KEY_1"] as const;

function missingRequiredEnvVars(): string[] {
    const missing: string[] = [];
    for (const key of REQUIRED_ENV_VARS) {
        if (!process.env[key] || process.env[key]?.trim().length === 0) {
            missing.push(key);
        }
    }
    return missing;
}

const hasProviderKeys = missingRequiredEnvVars().length === 0;
const describeProviderLive = RUN_WORKFLOW_LIVE_INTEGRATION && hasProviderKeys ? describe : describe.skip;
const hasMistralKeys = MISTRAL_REQUIRED_ENV_VARS.every((key) => !!process.env[key]?.trim());
const describeMistralProviderLive = RUN_WORKFLOW_LIVE_INTEGRATION && hasMistralKeys ? describe : describe.skip;
const MISTRAL_RATE_LIMIT_RETRY_DELAYS_MS = [65000] as const;

function extractWorkflowText(value: unknown): string {
    if (typeof value === "string") {
        return value;
    }
    if (Array.isArray((value as { content?: unknown })?.content)) {
        return ((value as { content: Array<{ type?: string; text?: string }> }).content ?? [])
            .filter((part) => part?.type === "text" && typeof part?.text === "string")
            .map((part) => part.text ?? "")
            .join("");
    }
    return String(value ?? "");
}

function isMistralRateLimitError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error ?? "");
    return message.includes("Status 429") || message.includes("rate_limited") || message.includes("Rate limit exceeded");
}

async function retryOnMistralRateLimit<T>(operation: () => Promise<T>): Promise<T> {
    let lastError: unknown;

    for (let attempt = 0; attempt <= MISTRAL_RATE_LIMIT_RETRY_DELAYS_MS.length; attempt += 1) {
        try {
            return await operation();
        } catch (error) {
            lastError = error;
            if (!isMistralRateLimitError(error) || attempt === MISTRAL_RATE_LIMIT_RETRY_DELAYS_MS.length) {
                throw error;
            }

            await new Promise((resolve) => setTimeout(resolve, MISTRAL_RATE_LIMIT_RETRY_DELAYS_MS[attempt]));
        }
    }

    throw lastError;
}

function createManagedJob<TOutput>(
    client: AIClient,
    executor: (
        input: void,
        ctx: MultiModalExecutionContext,
        signal?: AbortSignal,
        onChunk?: (chunk: any, internalChunk?: any) => void
    ) => Promise<any>,
    streaming = false
): GenericJob<void, TOutput> {
    const job = new GenericJob<void, TOutput>(undefined, streaming, executor);
    client.jobManager!.addJob(job);
    return job;
}

describe("Workflow Integration (deterministic)", () => {
    it("emits onNodeChunk for streaming nodes at workflow level", async () => {
        const client = new AIClient(new JobManager());
        const seen: string[] = [];
        const runner = new WorkflowRunner({
            jobManager: client.jobManager!,
            client,
            hooks: {
                onNodeChunk: (_wf, nodeId, chunk) => {
                    if (typeof chunk.delta === "string") {
                        seen.push(`${nodeId}:${chunk.delta}`);
                    }
                }
            }
        });

        const workflow = new WorkflowBuilder<{ out: string }>("integration-stream-hooks")
            .node("streamNode", (_ctx, nodeClient) =>
                createManagedJob<string>(
                    nodeClient,
                    async (_in, _x, _signal, onChunk) => {
                        onChunk?.({ delta: "a" }, { output: "a", done: false, delta: "a" });
                        onChunk?.({ delta: "b" }, { output: "ab", done: false, delta: "b" });
                        return { output: "ab", id: "stream-job", metadata: { status: "completed" } };
                    },
                    true
                )
            )
            .aggregate((results) => ({ out: String(results.streamNode) }))
            .build();

        const execution = await runner.run(workflow, new MultiModalExecutionContext());
        expect(execution.status).toBe("completed");
        expect(seen).toContain("streamNode:a");
        expect(seen).toContain("streamNode:b");
    });

    it("forwards nested child workflow streaming to parent runner hooks", async () => {
        const client = new AIClient(new JobManager());
        const seenNodeIds: string[] = [];
        const runner = new WorkflowRunner({
            jobManager: client.jobManager!,
            client,
            hooks: {
                onNodeChunk: (_wf, nodeId, chunk) => {
                    if (typeof chunk.delta === "string") {
                        seenNodeIds.push(nodeId);
                    }
                }
            }
        });

        const child = new WorkflowBuilder<{ out: string }>("child-integration-stream")
            .node("childStream", (_ctx, nodeClient) =>
                createManagedJob<string>(
                    nodeClient,
                    async (_in, _x, _signal, onChunk) => {
                        onChunk?.({ delta: "child-delta" }, { output: "child-delta", done: false, delta: "child-delta" });
                        return { output: "child-final", id: "child-stream", metadata: { status: "completed" } };
                    },
                    true
                )
            )
            .aggregate((results) => ({ out: String(results.childStream) }))
            .build();

        const parent = new WorkflowBuilder<{ nested: unknown }>("parent-integration-stream")
            .node("runChild", (_ctx, _nodeClient, nodeRunner) => nodeRunner.createWorkflowJob(child))
            .aggregate((results) => ({ nested: results.runChild }))
            .build();

        const execution = await runner.run(parent, new MultiModalExecutionContext());
        expect(execution.status).toBe("completed");
        expect(seenNodeIds.some((id) => id.includes("child-integration-stream.childStream"))).toBe(true);
    });

    it("runs parallel fanout + aggregate deterministically", async () => {
        const client = new AIClient(new JobManager());
        const runner = new WorkflowRunner({ jobManager: client.jobManager!, client });

        const workflow = new WorkflowBuilder<{ a: string; b: string; c: string }>("integration-fanout")
            .node("a", (_ctx, nodeClient) =>
                createManagedJob<string>(nodeClient, async () => ({ output: "A", id: "a", metadata: { status: "completed" } }))
            )
            .node("b", (_ctx, nodeClient) =>
                createManagedJob<string>(nodeClient, async () => ({ output: "B", id: "b", metadata: { status: "completed" } }))
            )
            .node("c", (_ctx, nodeClient) =>
                createManagedJob<string>(nodeClient, async () => ({ output: "C", id: "c", metadata: { status: "completed" } }))
            )
            .aggregate((results) => ({ a: String(results.a), b: String(results.b), c: String(results.c) }))
            .build();

        const execution = await runner.run(workflow, new MultiModalExecutionContext());
        expect(execution.status).toBe("completed");
        expect(execution.output).toEqual({ a: "A", b: "B", c: "C" });
        expect(execution.results.filter((r) => !r.skipped).length).toBe(3);
    });

    it("skips downstream step based on previous step output", async () => {
        const client = new AIClient(new JobManager());
        const runner = new WorkflowRunner({ jobManager: client.jobManager!, client });

        const workflow = new WorkflowBuilder<{ seed: string }>("integration-conditional-skip")
            .node("seed", (_ctx, nodeClient) =>
                createManagedJob<string>(nodeClient, async () => ({
                    output: "skip-next",
                    id: "seed",
                    metadata: { status: "completed" }
                }))
            )
            .after(
                "seed",
                "skipMe",
                (_ctx, nodeClient) =>
                    createManagedJob<string>(nodeClient, async () => ({
                        output: "should-not-run",
                        id: "skipMe",
                        metadata: { status: "completed" }
                    })),
                {
                    condition: (state) => state.values.seed === "run-next"
                }
            )
            .aggregate((results) => ({ seed: String(results.seed) }))
            .build();

        const execution = await runner.run(workflow, new MultiModalExecutionContext());
        expect(execution.status).toBe("completed");
        expect(execution.results.find((r) => r.stepId === "skipMe")?.skipped).toBe(true);
    });

    it("executes nested workflow as a node and returns nested output", async () => {
        const client = new AIClient(new JobManager());
        const runner = new WorkflowRunner({ jobManager: client.jobManager!, client });

        const child = new WorkflowBuilder<{ child: string }>("integration-child")
            .node("childStep", (_ctx, nodeClient) =>
                createManagedJob<string>(nodeClient, async () => ({
                    output: "child-ok",
                    id: "childStep",
                    metadata: { status: "completed" }
                }))
            )
            .aggregate((results) => ({ child: String(results.childStep) }))
            .build();

        const parent = new WorkflowBuilder<{ nested: unknown }>("integration-parent")
            .node("runChild", (_ctx, _nodeClient, nodeRunner) => nodeRunner.createWorkflowJob(child))
            .aggregate((results) => ({ nested: results.runChild }))
            .build();

        const execution = await runner.run(parent, new MultiModalExecutionContext());
        expect(execution.status).toBe("completed");
        expect(JSON.stringify(execution.output?.nested)).toContain("child-ok");
    });

    it("resumes from persisted snapshot after forced failure", async () => {
        const client = new AIClient(new JobManager());
        let failStep2 = true;
        let persisted: any | undefined;

        const runner = new WorkflowRunner({
            jobManager: client.jobManager!,
            client,
            persistence: {
                persistWorkflowExecution: async (snapshot) => {
                    persisted = snapshot;
                },
                loadWorkflowExecution: async () => persisted
            }
        });

        const workflow = new WorkflowBuilder<{ a: string; b: string }>("integration-resume")
            .node("step1", (_ctx, nodeClient) =>
                createManagedJob<string>(nodeClient, async () => ({
                    output: "A",
                    id: "step1",
                    metadata: { status: "completed" }
                }))
            )
            .after("step1", "step2", (_ctx, nodeClient) =>
                createManagedJob<string>(nodeClient, async () => {
                    if (failStep2) {
                        throw new Error("forced-step2-failure");
                    }
                    return { output: "B", id: "step2", metadata: { status: "completed" } };
                })
            )
            .aggregate((results) => ({ a: String(results.step1), b: String(results.step2) }))
            .build();

        await expect(runner.run(workflow, new MultiModalExecutionContext())).rejects.toThrow("forced-step2-failure");
        expect(persisted?.status).toBe("error");
        expect(persisted?.completedNodeIds).toContain("step1");

        failStep2 = false;
        const resumed = await runner.resume(workflow, new MultiModalExecutionContext());
        expect(resumed.status).toBe("completed");
        expect(resumed.output).toEqual({ a: "A", b: "B" });
    });

    it("retries transient node failures and succeeds within attempt budget", async () => {
        const client = new AIClient(new JobManager());
        let attempts = 0;
        const runner = new WorkflowRunner({ jobManager: client.jobManager!, client });

        const workflow = new WorkflowBuilder<{ out: string }>("integration-retry")
            .node(
                "flaky",
                (_ctx, nodeClient) =>
                    createManagedJob<string>(nodeClient, async () => {
                        attempts++;
                        if (attempts < 3) {
                            throw new Error(`flaky-${attempts}`);
                        }
                        return { output: "retry-ok", id: "flaky", metadata: { status: "completed" } };
                    }),
                { retry: { attempts: 3, backoffMs: 5 } }
            )
            .aggregate((results) => ({ out: String(results.flaky) }))
            .build();

        const execution = await runner.run(workflow, new MultiModalExecutionContext());
        expect(execution.status).toBe("completed");
        expect(execution.output?.out).toBe("retry-ok");
        expect(attempts).toBe(3);
    });

    it("times out long-running node and surfaces timeout error", async () => {
        const client = new AIClient(new JobManager());
        const runner = new WorkflowRunner({ jobManager: client.jobManager!, client });

        const workflow = new WorkflowBuilder<{ out: string }>("integration-timeout")
            .node(
                "slow",
                (_ctx, nodeClient) =>
                    createManagedJob<string>(nodeClient, async () => {
                        await new Promise((resolve) => setTimeout(resolve, 100));
                        return { output: "late", id: "slow", metadata: { status: "completed" } };
                    }),
                { timeoutMs: 20 }
            )
            .aggregate((results) => ({ out: String(results.slow) }))
            .build();

        await expect(runner.run(workflow, new MultiModalExecutionContext())).rejects.toThrow(
            "WorkflowRunner: node execution exceeded timeout of 20ms"
        );
    });

    it("uses built-in ApprovalGate + SaveFile in workflow", async () => {
        const outputDir = await mkdtemp(path.join(tmpdir(), "workflow-integration-save-"));
        const outputPath = path.join(outputDir, "approved.txt");

        const client = new AIClient(new JobManager());
        const approvalExecutor = createApprovalGateExecutor();
        const saveFileExecutor = createSaveFileExecutor({ allowAbsolutePath: true, autoCreateDir: true });
        const runner = new WorkflowRunner({ jobManager: client.jobManager!, client });

        const workflow = new WorkflowBuilder<{ path: string; status: string }>("integration-builtins")
            .node("approval", (_ctx, nodeClient) =>
                createManagedJob<any>(nodeClient, async (_in, _x, signal) => {
                    return approvalExecutor.invoke(
                        undefined as any,
                        {
                            input: {
                                requestedAt: new Date().toISOString(),
                                decision: { status: "approved", reason: "integration", approver: "ci" }
                            }
                        },
                        new MultiModalExecutionContext(),
                        signal
                    );
                })
            )
            .after("approval", "save", (_ctx, nodeClient, _runner, state) =>
                createManagedJob<any>(nodeClient, async (_in, _x, signal) => {
                    return saveFileExecutor.invoke(
                        undefined as any,
                        {
                            input: {
                                path: outputPath,
                                contentType: "text",
                                text: `status=${(state.values.approval as { status: string }).status}`
                            }
                        },
                        new MultiModalExecutionContext(),
                        signal
                    );
                })
            )
            .aggregate((results) => ({
                path: String((results.save as { path: string }).path),
                status: String((results.approval as { status: string }).status)
            }))
            .build();

        const execution = await runner.run(workflow, new MultiModalExecutionContext());
        expect(execution.status).toBe("completed");
        expect(execution.output?.status).toBe("approved");
        expect(execution.output?.path).toBe(outputPath);
        expect(await readFile(outputPath, "utf8")).toContain("status=approved");
    });

    it("runs a multi-step multi-modal non-streaming workflow with provider-chain fallback", async () => {
        const attempts: Array<{ kind: "success" | "failure"; capability: string; attemptIndex: number }> = [];
        const client = new AIClient(new JobManager());
        client.setLifecycleHooks({
            onAttemptFailure: (attempt) =>
                attempts.push({
                    kind: "failure",
                    capability: attempt.capability,
                    attemptIndex: attempt.attemptIndex
                }),
            onAttemptSuccess: (attempt) =>
                attempts.push({
                    kind: "success",
                    capability: attempt.capability,
                    attemptIndex: attempt.attemptIndex
                })
        });

        const seedKey = "customIntegrationSeed";
        const imageKey = "customIntegrationImage";
        const analyzeKey = "customIntegrationAnalyze";

        client.registerCapabilityExecutor(seedKey, {
            streaming: false,
            async invoke() {
                return {
                    output: "cyberpunk-scene-seed",
                    id: "seed-job",
                    multimodalArtifacts: {
                        chat: [{ id: "seed-msg", role: "assistant", content: [{ type: "text", text: "cyberpunk-scene-seed" }] }]
                    },
                    metadata: { status: "completed" }
                };
            }
        });

        client.registerCapabilityExecutor(imageKey, {
            streaming: false,
            async invoke(_capability, request: any) {
                const prompt = String(request?.input?.prompt ?? "");
                return {
                    output: [{ id: "img-1", mimeType: "image/png", base64: "AQID", url: "data:image/png;base64,AQID" }],
                    id: "image-job",
                    multimodalArtifacts: {
                        images: [{ id: "img-1", mimeType: "image/png", base64: "AQID", url: "data:image/png;base64,AQID" }],
                        chat: [{ id: "img-msg", role: "assistant", content: [{ type: "text", text: `image-from:${prompt}` }] }]
                    },
                    metadata: { status: "completed" }
                };
            }
        });

        client.registerCapabilityExecutor(analyzeKey, {
            streaming: false,
            async invoke(_capability, request: any) {
                const imageCount = Array.isArray(request?.input?.images) ? request.input.images.length : 0;
                return {
                    output: [{ id: "analysis-1", description: `images:${imageCount}`, tags: ["cyberpunk", "rain"] }],
                    id: "analyze-job",
                    multimodalArtifacts: {
                        imageAnalysis: [{ id: "analysis-1", description: `images:${imageCount}`, tags: ["cyberpunk", "rain"] }]
                    },
                    metadata: { status: "completed" }
                };
            }
        });

        const runner = new WorkflowRunner({ jobManager: client.jobManager!, client });
        const fallbackChain: ProviderRef[] = [
            { providerType: "openai", connectionName: "missing-connection" },
            { providerType: "gemini", connectionName: "default" },
            { providerType: "anthropic", connectionName: "default" }
        ];

        const workflow = new WorkflowBuilder<{ seed: string; imageCount: number; analysis: string }>("integration-multimodal-nonstream")
            .capabilityNode(
                "seed",
                seedKey,
                {
                    input: { topic: "city" }
                },
                { providerChain: fallbackChain, timeoutMs: 15000 }
            )
            .capabilityAfter(
                "seed",
                "generateImage",
                imageKey,
                (_ctx, state) => ({
                    input: { prompt: String(state.values.seed) }
                }),
                { providerChain: fallbackChain, timeoutMs: 15000 }
            )
            .capabilityAfter(
                "generateImage",
                "analyzeImage",
                analyzeKey,
                (_ctx, state) => ({
                    input: { images: state.values.generateImage }
                }),
                { providerChain: fallbackChain, timeoutMs: 15000 }
            )
            .aggregate((results) => {
                const generated = results.generateImage as Array<{ id: string }>;
                const analysis = results.analyzeImage as Array<{ description?: string }>;
                return {
                    seed: String(results.seed),
                    imageCount: generated.length,
                    analysis: String(analysis[0]?.description ?? "")
                };
            })
            .build();

        const execution = await runner.run(workflow, new MultiModalExecutionContext());
        expect(execution.status).toBe("completed");
        expect(execution.output).toEqual({
            seed: "cyberpunk-scene-seed",
            imageCount: 1,
            analysis: "images:1"
        });
        expect(execution.results.filter((r) => !r.skipped).length).toBe(3);
        expect(attempts.some((a) => a.kind === "failure" && a.attemptIndex === 0)).toBe(true);
        expect(attempts.some((a) => a.kind === "success" && a.attemptIndex === 1)).toBe(true);
    });

    it("runs mixed streaming + non-streaming multi-provider workflow with fallback", async () => {
        const client = new AIClient(new JobManager());
        const streamedDeltas: string[] = [];

        const streamKey = "customIntegrationStreamDraft";
        const finalizeKey = "customIntegrationFinalize";

        client.registerCapabilityExecutor(streamKey, {
            streaming: true,
            async *invoke() {
                let assembled = "";
                for (const part of ["alpha ", "beta ", "gamma"]) {
                    assembled += part;
                    yield {
                        delta: part,
                        output: assembled,
                        done: false,
                        id: "stream-draft-job",
                        metadata: { status: "incomplete" },
                        multimodalArtifacts: {
                            chat: [{ id: "stream-msg", role: "assistant", content: [{ type: "text", text: part }] }]
                        }
                    };
                }
                yield {
                    output: assembled,
                    done: true,
                    id: "stream-draft-job",
                    metadata: { status: "completed" }
                };
            }
        });

        client.registerCapabilityExecutor(finalizeKey, {
            streaming: false,
            async invoke(_capability, request: any) {
                const draft = String(request?.input?.draft ?? "");
                return {
                    output: { finalText: draft.trim().toUpperCase(), length: draft.trim().length },
                    id: "finalize-job",
                    metadata: { status: "completed" }
                };
            }
        });

        const runner = new WorkflowRunner({
            jobManager: client.jobManager!,
            client,
            hooks: {
                onNodeChunk: (_workflowId, nodeId, chunk) => {
                    if (nodeId === "streamDraft" && typeof chunk.delta === "string") {
                        streamedDeltas.push(chunk.delta);
                    }
                }
            }
        });

        const fallbackChain: ProviderRef[] = [
            { providerType: "openai", connectionName: "missing-connection" },
            { providerType: "openai", connectionName: "default" }
        ];

        const workflow = new WorkflowBuilder<{ draft: string; finalText: string; length: number }>("integration-mixed-stream")
            .capabilityNode(
                "streamDraft",
                streamKey,
                {
                    input: { prompt: "draft with chunks" }
                },
                { providerChain: fallbackChain, timeoutMs: 15000 }
            )
            .capabilityAfter(
                "streamDraft",
                "finalize",
                finalizeKey,
                (_ctx, state) => ({
                    input: { draft: String(state.values.streamDraft) }
                }),
                { providerChain: fallbackChain, timeoutMs: 15000 }
            )
            .aggregate((results) => {
                const finalized = results.finalize as { finalText: string; length: number };
                return {
                    draft: String(results.streamDraft),
                    finalText: finalized.finalText,
                    length: finalized.length
                };
            })
            .build();

        const execution = await runner.run(workflow, new MultiModalExecutionContext());
        expect(execution.status).toBe("completed");
        expect(execution.output?.draft).toBe("alpha beta gamma");
        expect(execution.output?.finalText).toBe("ALPHA BETA GAMMA");
        expect(execution.output?.length).toBe(16);
        expect(streamedDeltas.join("")).toBe("alpha beta gamma");
        expect(execution.results.filter((r) => !r.skipped).length).toBe(2);
    });

    it("runs conditional branching with fan-out/fan-in and validates skip behavior across modes", async () => {
        const client = new AIClient(new JobManager());
        const runner = new WorkflowRunner({ jobManager: client.jobManager!, client });

        let enableFanout = true;

        const workflow = new WorkflowBuilder<{ mode: string; summary: string }>("integration-conditional-fanout-fanin")
            .node("seed", (_ctx, nodeClient) =>
                createManagedJob<{ doFanout: boolean }>(nodeClient, async () => ({
                    output: { doFanout: enableFanout },
                    id: "seed",
                    metadata: { status: "completed" }
                }))
            )
            .after(
                "seed",
                "branchA",
                (_ctx, nodeClient) =>
                    createManagedJob<string>(nodeClient, async () => ({
                        output: "A",
                        id: "branchA",
                        metadata: { status: "completed" }
                    })),
                { condition: (state) => Boolean((state.values.seed as { doFanout?: boolean })?.doFanout) }
            )
            .after(
                "seed",
                "branchB",
                (_ctx, nodeClient) =>
                    createManagedJob<string>(nodeClient, async () => ({
                        output: "B",
                        id: "branchB",
                        metadata: { status: "completed" }
                    })),
                { condition: (state) => Boolean((state.values.seed as { doFanout?: boolean })?.doFanout) }
            )
            .after(
                "seed",
                "singlePath",
                (_ctx, nodeClient) =>
                    createManagedJob<string>(nodeClient, async () => ({
                        output: "S",
                        id: "singlePath",
                        metadata: { status: "completed" }
                    })),
                { condition: (state) => !Boolean((state.values.seed as { doFanout?: boolean })?.doFanout) }
            )
            .after(
                ["branchA", "branchB"],
                "mergeFanout",
                (_ctx, nodeClient, _nodeRunner, state) =>
                    createManagedJob<string>(nodeClient, async () => ({
                        output: `${String(state.values.branchA)}|${String(state.values.branchB)}`,
                        id: "mergeFanout",
                        metadata: { status: "completed" }
                    })),
                { condition: (state) => Boolean((state.values.seed as { doFanout?: boolean })?.doFanout) }
            )
            .after(
                "singlePath",
                "mergeSingle",
                (_ctx, nodeClient, _nodeRunner, state) =>
                    createManagedJob<string>(nodeClient, async () => ({
                        output: String(state.values.singlePath),
                        id: "mergeSingle",
                        metadata: { status: "completed" }
                    })),
                { condition: (state) => !Boolean((state.values.seed as { doFanout?: boolean })?.doFanout) }
            )
            .aggregate((results, state) => ({
                mode: (state.values.seed as { doFanout?: boolean })?.doFanout ? "fanout" : "single",
                summary: String(results.mergeFanout ?? results.mergeSingle ?? "")
            }))
            .build();

        const fanoutExecution = await runner.run(workflow, new MultiModalExecutionContext());
        expect(fanoutExecution.status).toBe("completed");
        expect(fanoutExecution.output).toEqual({ mode: "fanout", summary: "A|B" });
        expect(fanoutExecution.results.find((r) => r.stepId === "branchA")?.skipped).toBeUndefined();
        expect(fanoutExecution.results.find((r) => r.stepId === "branchB")?.skipped).toBeUndefined();
        expect(fanoutExecution.results.find((r) => r.stepId === "singlePath")?.skipped).toBe(true);
        expect(fanoutExecution.results.find((r) => r.stepId === "mergeSingle")?.skipped).toBe(true);

        enableFanout = false;
        const singleExecution = await runner.run(workflow, new MultiModalExecutionContext());
        expect(singleExecution.status).toBe("completed");
        expect(singleExecution.output).toEqual({ mode: "single", summary: "S" });
        expect(singleExecution.results.find((r) => r.stepId === "branchA")?.skipped).toBe(true);
        expect(singleExecution.results.find((r) => r.stepId === "branchB")?.skipped).toBe(true);
        expect(singleExecution.results.find((r) => r.stepId === "singlePath")?.skipped).toBeUndefined();
        expect(singleExecution.results.find((r) => r.stepId === "mergeFanout")?.skipped).toBe(true);
    });
});

describeProviderLive("Workflow Integration (provider-backed)", () => {
    it("runs a minimal real-provider workflow smoke test", async () => {
        const providerChain: ProviderRef[] = [{ providerType: "openai", connectionName: "default" }];

        const client = new AIClient(new JobManager());
        const runner = new WorkflowRunner({
            jobManager: client.jobManager!,
            client
        });

        const workflow = new WorkflowBuilder<{ draftText: string }>("live-workflow-smoke")
            .capabilityNode(
                "draft",
                CapabilityKeys.ChatCapabilityKey,
                {
                    input: {
                        messages: [
                            {
                                role: "user",
                                content: [{ type: "text", text: "Return exactly this token and nothing else: workflow-live-smoke-ok" }]
                            }
                        ]
                    },
                    options: {
                        model: "gpt-4.1"
                    },
                    timeoutMs: 30000
                },
                {
                    timeoutMs: 45000,
                    providerChain
                }
            )
            .aggregate((results) => ({
                draftText: JSON.stringify(results.draft)
            }))
            .build();

        let execution;
        try {
            execution = await retryOnMistralRateLimit(() => runner.run(workflow, new MultiModalExecutionContext()));
        } catch (error) {
            if (error instanceof AllProvidersFailedError) {
                throw new Error(
                    `Live provider smoke failed. Attempts: ${JSON.stringify(
                        error.attempts.map((a) => ({
                            providerType: a.providerType,
                            connectionName: a.connectionName,
                            error: a.error,
                            errorCode: a.errorCode
                        })),
                        null,
                        2
                    )}`
                );
            }
            throw error;
        }
        expect(execution.status).toBe("completed");
        expect(execution.output?.draftText.toLowerCase()).toContain("workflow-live-smoke-ok");
    });

    it("falls back across provider chain when first provider connection fails", async () => {
        const attempts: Array<{ kind: "success" | "failure"; attemptIndex: number }> = [];
        const client = new AIClient(new JobManager());
        client.setLifecycleHooks({
            onAttemptFailure: (attempt) =>
                attempts.push({
                    kind: "failure",
                    attemptIndex: attempt.attemptIndex
                }),
            onAttemptSuccess: (attempt) =>
                attempts.push({
                    kind: "success",
                    attemptIndex: attempt.attemptIndex
                })
        });

        const runner = new WorkflowRunner({ jobManager: client.jobManager!, client });
        const workflow = new WorkflowBuilder<{ text: string }>("live-fallback")
            .capabilityNode(
                "ask",
                CapabilityKeys.ChatCapabilityKey,
                {
                    input: {
                        messages: [
                            {
                                role: "user",
                                content: [{ type: "text", text: "Reply with fallback-live-ok." }]
                            }
                        ]
                    },
                    options: {
                        model: "gpt-4.1"
                    }
                },
                {
                    providerChain: [
                        { providerType: "openai", connectionName: "missing-connection" },
                        { providerType: "openai", connectionName: "default" }
                    ],
                    timeoutMs: 45000
                }
            )
            .aggregate((results) => ({ text: JSON.stringify(results.ask) }))
            .build();

        let execution;
        try {
            execution = await runner.run(workflow, new MultiModalExecutionContext());
        } catch (error) {
            if (error instanceof AllProvidersFailedError) {
                throw new Error(
                    `Live provider fallback failed. Attempts: ${JSON.stringify(
                        error.attempts.map((a) => ({
                            providerType: a.providerType,
                            connectionName: a.connectionName,
                            error: a.error,
                            errorCode: a.errorCode
                        })),
                        null,
                        2
                    )}`
                );
            }
            throw error;
        }
        expect(execution.status).toBe("completed");
        expect(execution.output?.text.toLowerCase()).toContain("fallback-live-ok");
        expect(attempts.some((a) => a.kind === "failure" && a.attemptIndex === 0)).toBe(true);
        expect(attempts.some((a) => a.kind === "success" && a.attemptIndex === 1)).toBe(true);
    });

    it("runs a real-provider streaming smoke test and emits workflow chunks", async () => {
        const providerChain: ProviderRef[] = [{ providerType: "openai", connectionName: "default" }];
        const chunkDeltas: string[] = [];

        const client = new AIClient(new JobManager());
        const runner = new WorkflowRunner({
            jobManager: client.jobManager!,
            client,
            hooks: {
                onNodeChunk: (_workflowId, _nodeId, chunk) => {
                    if (chunk.delta !== undefined) {
                        const text = extractWorkflowText(chunk.delta);
                        if (text.length > 0) {
                            chunkDeltas.push(text);
                        }
                    }
                }
            }
        });

        const workflow = new WorkflowBuilder<{ text: string; chunksObserved: number }>("live-workflow-stream-smoke")
            .capabilityNode(
                "draftStream",
                CapabilityKeys.ChatStreamCapabilityKey,
                {
                    input: {
                        messages: [
                            {
                                role: "user",
                                content: [{ type: "text", text: "Reply with exactly: workflow-live-stream-ok" }]
                            }
                        ]
                    },
                    options: {
                        model: "gpt-4.1"
                    },
                    timeoutMs: 30000
                },
                {
                    timeoutMs: 45000,
                    providerChain
                }
            )
            .aggregate((results) => {
                const draft = results.draftStream as any;
                const text =
                    typeof draft === "string"
                        ? draft
                        : Array.isArray(draft?.content)
                          ? draft.content
                                .filter((part: any) => part?.type === "text" && typeof part?.text === "string")
                                .map((part: any) => part.text)
                                .join("")
                          : String(draft ?? "");

                return {
                    text,
                    chunksObserved: chunkDeltas.length
                };
            })
            .build();

        let execution;
        try {
            execution = await runner.run(workflow, new MultiModalExecutionContext());
        } catch (error) {
            if (error instanceof AllProvidersFailedError) {
                throw new Error(
                    `Live provider stream smoke failed. Attempts: ${JSON.stringify(
                        error.attempts.map((a) => ({
                            providerType: a.providerType,
                            connectionName: a.connectionName,
                            error: a.error,
                            errorCode: a.errorCode
                        })),
                        null,
                        2
                    )}`
                );
            }
            throw error;
        }

        expect(execution.status).toBe("completed");
        expect(execution.output?.text.toLowerCase()).toContain("workflow-live-stream-ok");
        expect(typeof execution.output?.chunksObserved).toBe("number");
        expect((execution.output?.chunksObserved ?? -1) >= 0).toBe(true);
    });
});

describeMistralProviderLive("Workflow Integration (provider-backed, mistral)", () => {
    it("runs a real-provider mistral streaming workflow and emits workflow chunks", async () => {
        const providerChain: ProviderRef[] = [{ providerType: "mistral", connectionName: "default" }];
        const chunkDeltas: string[] = [];

        const client = new AIClient(new JobManager());
        const runner = new WorkflowRunner({
            jobManager: client.jobManager!,
            client,
            hooks: {
                onNodeChunk: (_workflowId, nodeId, chunk) => {
                    if (nodeId !== "draftStream") {
                        return;
                    }

                    const extractedText = extractWorkflowText(chunk.delta);
                    if (extractedText.length > 0) {
                        chunkDeltas.push(extractedText);
                    }
                }
            }
        });

        const workflow = new WorkflowBuilder<{ text: string; chunksObserved: number }>("live-mistral-workflow-stream")
            .capabilityNode(
                "draftStream",
                CapabilityKeys.ChatStreamCapabilityKey,
                {
                    input: {
                        messages: [
                            {
                                role: "user",
                                content: [{ type: "text", text: "Reply with exactly: workflow-mistral-stream-ok" }]
                            }
                        ]
                    },
                    options: {
                        model: "mistral-small-latest",
                        generalParams: { chatStreamBatchSize: 8 }
                    },
                    timeoutMs: 30000
                },
                {
                    timeoutMs: 45000,
                    providerChain
                }
            )
            .aggregate((results) => ({
                text: extractWorkflowText(results.draftStream),
                chunksObserved: chunkDeltas.length
            }))
            .build();

        let execution;
        try {
            execution = await runner.run(workflow, new MultiModalExecutionContext());
        } catch (error) {
            if (error instanceof AllProvidersFailedError) {
                throw new Error(
                    `Live Mistral stream workflow failed. Attempts: ${JSON.stringify(
                        error.attempts.map((a) => ({
                            providerType: a.providerType,
                            connectionName: a.connectionName,
                            error: a.error,
                            errorCode: a.errorCode
                        })),
                        null,
                        2
                    )}`
                );
            }
            throw error;
        }

        expect(execution.status).toBe("completed");
        expect(execution.output?.text.toLowerCase()).toContain("workflow-mistral-stream-ok");
        expect(execution.output?.chunksObserved).toBeGreaterThan(0);
    });

    it("runs a real-provider mistral moderation batch workflow", async () => {
        const providerChain: ProviderRef[] = [{ providerType: "mistral", connectionName: "default" }];
        const client = new AIClient(new JobManager());
        const runner = new WorkflowRunner({ jobManager: client.jobManager!, client });

        const workflow = new WorkflowBuilder<{ total: number; flaggedCount: number; flaggedIndices: number[] }>(
            "live-mistral-workflow-moderation"
        )
            .capabilityNode(
                "moderate",
                CapabilityKeys.ModerationCapabilityKey,
                {
                    input: {
                        input: ["I enjoy sunny walks in the park.", "I want to kill everyone in this building."]
                    },
                    options: {
                        model: "mistral-moderation-latest"
                    },
                    timeoutMs: 30000
                },
                {
                    timeoutMs: 45000,
                    providerChain
                }
            )
            .aggregate((results) => {
                const moderation = Array.isArray(results.moderate)
                    ? (results.moderate as Array<{ flagged?: boolean; inputIndex?: number }>)
                    : [];
                return {
                    total: moderation.length,
                    flaggedCount: moderation.filter((item) => item.flagged).length,
                    flaggedIndices: moderation.filter((item) => item.flagged).map((item) => Number(item.inputIndex))
                };
            })
            .build();

        let execution;
        try {
            execution = await runner.run(workflow, new MultiModalExecutionContext());
        } catch (error) {
            if (error instanceof AllProvidersFailedError) {
                throw new Error(
                    `Live Mistral moderation workflow failed. Attempts: ${JSON.stringify(
                        error.attempts.map((a) => ({
                            providerType: a.providerType,
                            connectionName: a.connectionName,
                            error: a.error,
                            errorCode: a.errorCode
                        })),
                        null,
                        2
                    )}`
                );
            }
            throw error;
        }

        expect(execution.status).toBe("completed");
        expect(execution.output?.total).toBe(2);
        expect((execution.output?.flaggedCount ?? 0) >= 1).toBe(true);
        expect(execution.output?.flaggedIndices).toContain(1);
    });

    it(
        "runs a real-provider mistral image analysis workflow with a local PNG",
        async () => {
            const providerChain: ProviderRef[] = [{ providerType: "mistral", connectionName: "default" }];
            const client = new AIClient(new JobManager());
            const runner = new WorkflowRunner({ jobManager: client.jobManager!, client });
            const imageBase64 = (
                await readFile(new URL("../../../../test_data/test_cybercat.png", import.meta.url))
            ).toString("base64");

            const workflow = new WorkflowBuilder<{ count: number; sourceImageId: string; hasContent: boolean }>(
                "live-mistral-workflow-image-analysis"
            )
                .capabilityNode(
                    "analyze",
                    CapabilityKeys.ImageAnalysisCapabilityKey,
                    {
                        input: {
                            prompt: "Describe the main subject of this image and return concise tags.",
                            images: [
                                {
                                    id: "cybercat",
                                    sourceType: "base64",
                                    base64: imageBase64,
                                    mimeType: "image/png"
                                }
                            ]
                        },
                        options: {
                            model: "mistral-small-latest"
                        },
                        timeoutMs: 30000
                    },
                    {
                        timeoutMs: 45000,
                        providerChain
                    }
                )
                .aggregate((results) => {
                    const analyses = Array.isArray(results.analyze)
                        ? (results.analyze as Array<{
                              sourceImageId?: string;
                              description?: string;
                              tags?: string[];
                              objects?: Array<unknown>;
                              text?: Array<unknown>;
                          }>)
                        : [];

                    return {
                        count: analyses.length,
                        sourceImageId: String(analyses[0]?.sourceImageId ?? ""),
                        hasContent: Boolean(
                            analyses[0]?.description ||
                                (analyses[0]?.tags?.length ?? 0) > 0 ||
                                (analyses[0]?.objects?.length ?? 0) > 0 ||
                                (analyses[0]?.text?.length ?? 0) > 0
                        )
                    };
                })
                .build();

            let execution;
            try {
                execution = await retryOnMistralRateLimit(() => runner.run(workflow, new MultiModalExecutionContext()));
            } catch (error) {
                if (error instanceof AllProvidersFailedError) {
                    throw new Error(
                        `Live Mistral image-analysis workflow failed. Attempts: ${JSON.stringify(
                            error.attempts.map((a) => ({
                                providerType: a.providerType,
                                connectionName: a.connectionName,
                                error: a.error,
                                errorCode: a.errorCode
                            })),
                            null,
                            2
                        )}`
                    );
                }
                throw error;
            }

            expect(execution.status).toBe("completed");
            expect(execution.output?.count).toBeGreaterThan(0);
            expect(execution.output?.sourceImageId).toBe("cybercat");
            expect(execution.output?.hasContent).toBe(true);
        },
        150000
    );
});
