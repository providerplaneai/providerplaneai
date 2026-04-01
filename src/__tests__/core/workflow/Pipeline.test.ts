import { describe, expect, it, vi } from "vitest";
import {
    CapabilityKeys,
    GenericJob,
    JobManager,
    MultiModalExecutionContext,
    Pipeline,
    WorkflowRunner,
    type AIRequest
} from "#root/index.js";

function readPromptFromRequest(request: AIRequest<any>): string {
    const messages = request?.input?.messages;
    if (!Array.isArray(messages)) {
        return "";
    }
    const firstContent = messages[0]?.content?.[0];
    return typeof firstContent?.text === "string" ? firstContent.text : "";
}

function createPipelineHarness() {
    const jobManager = new JobManager();
    const createCapabilityJob = vi.fn(
        <TInput, TOutput>(capability: string, request: AIRequest<TInput>) => {
            const job = new GenericJob<AIRequest<TInput>, TOutput>(request, false, async (input) => {
                switch (capability) {
                    case CapabilityKeys.ChatCapabilityKey:
                    case CapabilityKeys.ChatStreamCapabilityKey: {
                        const prompt = readPromptFromRequest(input);
                        return {
                            output: {
                                role: "assistant",
                                content: [{ type: "text", text: `reply:${prompt}` }]
                            } as TOutput,
                            id: crypto.randomUUID(),
                            metadata: { status: "completed" }
                        };
                    }
                    case CapabilityKeys.AudioTextToSpeechCapabilityKey: {
                        const text = String((input as any)?.input?.text ?? "");
                        return {
                            output: [
                                {
                                    id: "audio-1",
                                    mimeType: "audio/mpeg",
                                    base64: Buffer.from(text, "utf8").toString("base64")
                                }
                            ] as TOutput,
                            id: crypto.randomUUID(),
                            metadata: { status: "completed" }
                        };
                    }
                    case CapabilityKeys.AudioTranscriptionCapabilityKey:
                    case CapabilityKeys.AudioTranslationCapabilityKey: {
                        const file = String((input as any)?.input?.file ?? "");
                        if (file.includes("structured-transcript")) {
                            return {
                                output: [
                                    {
                                        role: "assistant",
                                        content: [{ type: "text", text: "structured transcript" }],
                                        metadata: { status: "completed" },
                                        rawResponse: { outputText: "completed" }
                                    }
                                ] as TOutput,
                                id: crypto.randomUUID(),
                                metadata: { status: "completed" }
                            };
                        }
                        return {
                            output: `text-from:${file.slice(0, 16)}` as TOutput,
                            id: crypto.randomUUID(),
                            metadata: { status: "completed" }
                        };
                    }
                    case CapabilityKeys.ModerationCapabilityKey: {
                        const text = String((input as any)?.input?.input ?? "");
                        return {
                            output: [{ flagged: text.includes("unsafe") }] as TOutput,
                            id: crypto.randomUUID(),
                            metadata: { status: "completed" }
                        };
                    }
                    case CapabilityKeys.EmbedCapabilityKey: {
                        return {
                            output: [{ dimensions: 3, embedding: [0.1, 0.2, 0.3] }] as TOutput,
                            id: crypto.randomUUID(),
                            metadata: { status: "completed" }
                        };
                    }
                    case CapabilityKeys.ImageGenerationCapabilityKey: {
                        return {
                            output: [
                                {
                                    id: "img-1",
                                    mimeType: "image/png",
                                    base64: "AQID"
                                }
                            ] as TOutput,
                            id: crypto.randomUUID(),
                            metadata: { status: "completed" }
                        };
                    }
                    case CapabilityKeys.ImageAnalysisCapabilityKey: {
                        const images = ((input as any)?.input?.images ?? []) as any[];
                        return {
                            output: [{ text: `image-analysis:${images.length}` }] as TOutput,
                            id: crypto.randomUUID(),
                            metadata: { status: "completed" }
                        };
                    }
                    case CapabilityKeys.OCRCapabilityKey: {
                        const file = String((input as any)?.input?.file ?? "");
                        return {
                            output: [
                                {
                                    id: "ocr-1",
                                    fullText: `ocr-text:${file.slice(0, 24)}`,
                                    pages: [
                                        {
                                            pageNumber: 1,
                                            fullText: `ocr-text:${file.slice(0, 24)}`,
                                            metadata: {
                                                markdown: "| ![img-0](img-0.png) |"
                                            }
                                        }
                                    ]
                                }
                            ] as TOutput,
                            id: crypto.randomUUID(),
                            metadata: { status: "completed" }
                        };
                    }
                    case CapabilityKeys.SaveFileCapabilityKey: {
                        return {
                            output: {
                                path: (input as any)?.input?.path,
                                contentType: (input as any)?.input?.contentType,
                                base64: (input as any)?.input?.base64,
                                text: (input as any)?.input?.text
                            } as TOutput,
                            id: crypto.randomUUID(),
                            metadata: { status: "completed" }
                        };
                    }
                    case CapabilityKeys.VideoGenerationCapabilityKey: {
                        return {
                            output: [{ id: "vid-1", url: "https://example.com/v1.mp4", mimeType: "video/mp4" }] as TOutput,
                            id: crypto.randomUUID(),
                            metadata: { status: "completed" }
                        };
                    }
                    case CapabilityKeys.VideoRemixCapabilityKey: {
                        const sourceVideoId = String((input as any)?.input?.sourceVideoId ?? "");
                        return {
                            output: [{ id: `${sourceVideoId}-remix`, url: "https://example.com/r.mp4", mimeType: "video/mp4" }] as TOutput,
                            id: crypto.randomUUID(),
                            metadata: { status: "completed" }
                        };
                    }
                    case CapabilityKeys.VideoDownloadCapabilityKey: {
                        const videoId = String((input as any)?.input?.videoId ?? "video-download");
                        const videoUri = String((input as any)?.input?.videoUri ?? "");
                        return {
                            output: [{ id: videoId, url: videoUri, mimeType: "video/mp4" }] as TOutput,
                            id: crypto.randomUUID(),
                            metadata: { status: "completed" }
                        };
                    }
                    case CapabilityKeys.VideoAnalysisCapabilityKey: {
                        return {
                            output: [{ text: "video-analysis-ok" }] as TOutput,
                            id: crypto.randomUUID(),
                            metadata: { status: "completed" }
                        };
                    }
                    case CapabilityKeys.ApprovalGateCapabilityKey: {
                        return {
                            output: { status: "approved" } as TOutput,
                            id: crypto.randomUUID(),
                            metadata: { status: "completed" }
                        };
                    }
                    default: {
                        const explicitValue = (input as any)?.input?.value;
                        return {
                            output: (explicitValue !== undefined ? explicitValue : (input as unknown)) as TOutput,
                            id: crypto.randomUUID(),
                            metadata: { status: "completed" }
                        };
                    }
                }
            });
            jobManager.addJob(job);
            return job;
        }
    );

    const client = {
        jobManager,
        createCapabilityJob
    } as any;

    const runner = new WorkflowRunner({ jobManager, client });
    const ctx = new MultiModalExecutionContext();
    return { jobManager, runner, client, ctx, createCapabilityJob };
}

describe("Pipeline", () => {
    it("builds workflow metadata and step handles", () => {
        const pipeline = new Pipeline("pipeline-meta")
            .defaults({ timeoutMs: 1000 })
            .version("1.2.3")
            .chat("a", "hello");
        const h = pipeline.step<number>("typed");
        expect(h.id).toBe("typed");
        const built = pipeline.build();

        expect(built.id).toBe("pipeline-meta");
        expect(built.version).toBe("1.2.3");
        expect(built.defaults).toMatchObject({ timeoutMs: 1000 });
    });

    it("applies constructor defaults option to builder metadata", () => {
        const workflow = new Pipeline("pipeline-constructor-defaults", {
            defaults: { timeoutMs: 2222 }
        })
            .chat("seed", "x")
            .build();
        expect(workflow.defaults).toMatchObject({ timeoutMs: 2222 });
    });

    it("renders template prompts and executes chat dependency chain", async () => {
        const { runner, ctx } = createPipelineHarness();
        const workflow = new Pipeline<{ text: string }>("pipeline-chat-chain")
            .chat("seed", "alpha")
            .chat("next", "From seed: {{seed}}", { after: "seed" })
            .output((values) => ({ text: JSON.stringify(values.next) }))
            .build();

        const execution = await runner.run(workflow, ctx);
        expect(execution.status).toBe("completed");
        expect(String(execution.output?.text)).toContain("reply:From seed:");
    });

    it("merges source dependency with explicit after dependency for source-bound steps", () => {
        const workflow = new Pipeline("pipeline-merge-after")
            .chat("seed", "hello")
            .tts("tts", { voice: "alloy" }, { source: "seed", after: "seed" })
            .build();

        const ttsNode = workflow.nodes.find((n) => n.id === "tts");
        expect(ttsNode?.dependsOn).toEqual(["seed"]);
    });

    it("supports custom and customAfter nodes", async () => {
        const { runner, ctx, jobManager } = createPipelineHarness();
        const workflow = new Pipeline<{ out: string }>("pipeline-custom")
            .node("raw", (_ctx, _client, _runner, state) => {
                const job = new GenericJob<void, string>(undefined, false, async () => ({
                    output: String(state.values.seed ?? "none"),
                    id: crypto.randomUUID(),
                    metadata: {}
                }));
                jobManager.addJob(job);
                return job;
            })
            .custom("seed", "customEcho", { input: { value: "hello" } })
            .customAfter("seed", "next", "customEcho", (_ctx, state) => ({
                input: { value: `next:${String(state.values.seed)}` }
            }))
            .output((values) => ({ out: JSON.stringify(values.next) }))
            .build();

        const execution = await runner.run(workflow, ctx);
        expect(execution.status).toBe("completed");
        expect(execution.output?.out).toContain("next:");
    });

    it("maps customAfter when-condition and skips dependent node", async () => {
        const { runner, ctx } = createPipelineHarness();
        const workflow = new Pipeline("pipeline-custom-after-when")
            .custom("seed", "customEcho", { input: { value: "hello" } })
            .customAfter(
                "seed",
                "conditionalNext",
                "customEcho",
                (_ctx, state) => ({ input: { value: `next:${String(state.values.seed)}` } }),
                { when: () => false }
            )
            .build();

        const execution = await runner.run(workflow, ctx);
        expect(execution.status).toBe("completed");
        expect(execution.results.find((r) => r.stepId === "conditionalNext")?.skipped).toBe(true);
    });

    it("normalizes outputs with text preset and keepRaw", async () => {
        const { runner, ctx } = createPipelineHarness();
        const workflow = new Pipeline<{ v: string; rawType: string }>("pipeline-normalize")
            .chat("seed", "normalize-me", { normalize: "text", keepRaw: true })
            .output((values) => {
                const seed = values.seed as { value: string; raw: unknown };
                return {
                    v: seed.value,
                    rawType: typeof seed.raw
                };
            })
            .build();

        const execution = await runner.run(workflow, ctx);
        expect(execution.status).toBe("completed");
        expect(execution.output?.v).toContain("reply:normalize-me");
        expect(execution.output?.rawType).toBe("object");
    });

    it("supports custom normalize function", async () => {
        const { runner, ctx } = createPipelineHarness();
        const workflow = new Pipeline<{ out: string }>("pipeline-normalize-custom")
            .chat("seed", "x", {
                normalize: (raw) => `n:${JSON.stringify(raw).length}`
            })
            .output((values) => ({ out: String(values.seed) }))
            .build();

        const execution = await runner.run(workflow, ctx);
        expect(execution.status).toBe("completed");
        expect(execution.output?.out.startsWith("n:")).toBe(true);
    });

    it("supports normalize presets for artifact and image outputs", async () => {
        const { runner, ctx } = createPipelineHarness();
        const workflow = new Pipeline<{ audioMime: string; imageSourceType: string }>("pipeline-normalize-presets")
            .chat("seed", "preset-check")
            .tts("audio", { voice: "alloy", format: "mp3" }, { source: "seed", normalize: "artifact" })
            .imageGenerate("image", { prompt: "a test image" }, { normalize: "image" })
            .output((values) => ({
                audioMime: String((values.audio as any)?.mimeType ?? ""),
                imageSourceType: String((values.image as any)?.sourceType ?? "")
            }))
            .build();

        const execution = await runner.run(workflow, ctx);
        expect(execution.status).toBe("completed");
        expect(execution.output?.audioMime).toBe("audio/mpeg");
        expect(execution.output?.imageSourceType).toBe("base64");
    });

    it("normalization keeps normalized-only output when keepRaw is omitted", async () => {
        const { runner, ctx } = createPipelineHarness();
        const workflow = new Pipeline<{ valueType: string }>("pipeline-normalize-no-raw")
            .chat("seed", "normalized-only", { normalize: "text" })
            .output((values) => ({
                valueType: typeof values.seed
            }))
            .build();

        const execution = await runner.run(workflow, ctx);
        expect(execution.status).toBe("completed");
        expect(execution.output?.valueType).toBe("string");
    });

    it("normalizes transcription text from assistant message content without metadata noise", async () => {
        const { runner, ctx } = createPipelineHarness();
        const workflow = new Pipeline<{ transcript: string }>("pipeline-normalize-transcription")
            .custom("artifactSeed", "customEcho", {
                input: {
                    value: {
                        id: "artifact-structured",
                        mimeType: "audio/mpeg",
                        url: "structured-transcript"
                    }
                }
            })
            .transcribe("tx", { responseFormat: "text" }, { source: "artifactSeed", normalize: "text" })
            .output((values) => ({
                transcript: String(values.tx ?? "")
            }))
            .build();

        const execution = await runner.run(workflow, ctx);
        expect(execution.status).toBe("completed");
        expect(execution.output?.transcript).toBe("structured transcript");
    });

    it("routes imageGenerate -> imageAnalyze -> saveFile with base64 artifact path templating", async () => {
        const { runner, ctx } = createPipelineHarness();
        const workflow = new Pipeline<{ savedPath: string; contentType: string }>("pipeline-image-save")
            .chat("prompt", "a cyberpunk street at night")
            .imageGenerate("img", { prompt: "{{prompt}}" }, { after: "prompt" })
            .imageAnalyze("analyze", {}, { source: "img" })
            .saveFile(
                "save",
                {
                    path: "test_data/{{analyze}}-{artifactId}.png"
                },
                { source: "img", after: "analyze" }
            )
            .output((values) => ({
                savedPath: String((values.save as any)?.path ?? ""),
                contentType: String((values.save as any)?.contentType ?? "")
            }))
            .build();

        const execution = await runner.run(workflow, ctx);
        expect(execution.status).toBe("completed");
        expect(execution.output?.savedPath).toContain("img-1");
        expect(execution.output?.contentType).toBe("base64");
    });

    it("routes imageGenerate -> ocr and supports normalize text for OCR output", async () => {
        const { runner, ctx, createCapabilityJob } = createPipelineHarness();
        const workflow = new Pipeline<{ ocrText: string }>("pipeline-ocr")
            .imageGenerate("img", { prompt: "generate receipt image" })
            .ocr("ocr", { language: "en" }, { source: "img", normalize: "text" })
            .output((values) => ({ ocrText: String(values.ocr ?? "") }))
            .build();

        const execution = await runner.run(workflow, ctx);
        expect(execution.status).toBe("completed");
        expect(execution.output?.ocrText).toContain("ocr-text:data:image/png;base64");

        const call = createCapabilityJob.mock.calls.find(([cap]) => cap === CapabilityKeys.OCRCapabilityKey);
        expect(call?.[1]).toMatchObject({
            input: {
                language: "en"
            }
        });
        expect(String(call?.[1]?.input?.file ?? "")).toContain("data:image/png;base64,AQID");
    });

    it("videoAnalyze can use multiple source steps and picks first usable artifact", async () => {
        const { runner, ctx } = createPipelineHarness();
        const workflow = new Pipeline<{ summary: string }>("pipeline-video-analyze")
            .videoGenerate("v1", { prompt: "first video" })
            .videoDownload("v2", { videoUri: "https://example.com/v2.mp4", videoId: "v2-id" })
            .videoAnalyze("analyze", { prompt: "Summarize clip" }, { source: ["v1", "v2"] })
            .output((values) => ({ summary: JSON.stringify(values.analyze) }))
            .build();

        const execution = await runner.run(workflow, ctx);
        expect(execution.status).toBe("completed");
        expect(execution.output?.summary).toContain("video-analysis-ok");
    });

    it("throws for videoRemix when neither sourceVideoId nor source artifact id is available", async () => {
        const { runner, ctx } = createPipelineHarness();
        const workflow = new Pipeline("pipeline-video-remix-error")
            .videoRemix("remix", { prompt: "do remix" })
            .build();

        await expect(runner.run(workflow, ctx)).rejects.toThrow(
            "videoRemix requires sourceVideoId or a valid `source` step with an artifact id."
        );
    });

    it("supports approvalGate helper and provider mapping options", async () => {
        const { runner, ctx, createCapabilityJob, jobManager } = createPipelineHarness();
        const workflow = new Pipeline<{ status: string }>("pipeline-approval")
            .approvalGate(
                "approve",
                {
                    input: () => ({ approver: "ops" })
                },
                {
                    provider: "openai"
                }
            )
            .output((values) => ({ status: String((values.approve as any)?.status ?? "") }))
            .build();

        const execution = await runner.run(workflow, ctx);
        expect(execution.status).toBe("completed");
        expect(execution.output?.status).toBe("approved");
        const call = createCapabilityJob.mock.calls.find(([cap]) => cap === CapabilityKeys.ApprovalGateCapabilityKey);
        expect(call?.[2]).toMatchObject({
            providerChain: [{ providerType: "openai", connectionName: "default" }]
        });
    });

    it("supports approvalGate with static object input", async () => {
        const { runner, ctx, createCapabilityJob } = createPipelineHarness();
        const workflow = new Pipeline<{ status: string }>("pipeline-approval-static-input")
            .approvalGate("approve", { input: { approver: "static-user" } })
            .output((values) => ({ status: String((values.approve as any)?.status ?? "") }))
            .build();

        const execution = await runner.run(workflow, ctx);
        expect(execution.status).toBe("completed");
        expect(execution.output?.status).toBe("approved");

        const call = createCapabilityJob.mock.calls.find(([cap]) => cap === CapabilityKeys.ApprovalGateCapabilityKey);
        expect(call?.[1]).toMatchObject({
            input: { approver: "static-user" }
        });
    });

    it("uses explicit providerChain over provider shorthand when both are present", async () => {
        const { runner, ctx, createCapabilityJob, jobManager } = createPipelineHarness();
        const workflow = new Pipeline("pipeline-provider-precedence")
            .chat("seed", "x", {
                provider: "openai",
                providerChain: [{ providerType: "gemini", connectionName: "default" }]
            })
            .build();

        const execution = await runner.run(workflow, ctx);
        expect(execution.status).toBe("completed");

        const call = createCapabilityJob.mock.calls.find(([cap, req]) => cap === CapabilityKeys.ChatCapabilityKey && readPromptFromRequest(req) === "x");
        expect(call?.[2]).toMatchObject({
            providerChain: [{ providerType: "gemini", connectionName: "default" }]
        });
    });

    it("exposes underlying WorkflowBuilder via toWorkflowBuilder", () => {
        const pipeline = new Pipeline("pipeline-builder-escape");
        const builder = pipeline.toWorkflowBuilder();
        builder.node("a", vi.fn() as any);
        const workflow = pipeline.build();
        expect(workflow.nodes.map((n) => n.id)).toEqual(["a"]);
    });

    it("supports capabilityNode/capabilityAfter with step handles in after()", async () => {
        const { runner, ctx, createCapabilityJob, jobManager } = createPipelineHarness();
        const pipeline = new Pipeline<{ out: string }>("pipeline-raw-capability");
        const a = pipeline.step("a");
        const b = pipeline.step("b");
        const workflow = pipeline
            .capabilityNode(
                a.id,
                CapabilityKeys.ChatCapabilityKey,
                { input: { messages: [{ role: "user", content: [{ type: "text", text: "A" }] }] } },
                { timeoutMs: 10 }
            )
            .capabilityAfter(
                a,
                b.id,
                CapabilityKeys.ChatCapabilityKey,
                (_ctx, state) => ({
                    input: { messages: [{ role: "user", content: [{ type: "text", text: `B:${String(state.values[a.id])}` }] }] }
                }),
                { retry: { attempts: 1 }, addToManager: false }
            )
            .after([a, b], "join", (_ctx, _client, _runner, state) => {
                const job = new GenericJob<void, string>(undefined, false, async () => ({
                    output: `${JSON.stringify(state.values[a.id])}|${JSON.stringify(state.values[b.id])}`,
                    id: crypto.randomUUID(),
                    metadata: {}
                }));
                jobManager.addJob(job);
                return job;
            })
            .output((values) => ({ out: String(values.join) }))
            .build();

        const execution = await runner.run(workflow, ctx);
        expect(execution.status).toBe("completed");
        const calls = createCapabilityJob.mock.calls.filter(([cap]) => cap === CapabilityKeys.ChatCapabilityKey);
        expect(calls.length).toBeGreaterThanOrEqual(2);
        expect(calls[1]?.[2]).toMatchObject({ addToManager: false });
    });

    it("supports source select function for text source", async () => {
        const { runner, ctx } = createPipelineHarness();
        const pipeline = new Pipeline<{ out: string }>("pipeline-from-bindings");
        const seed = pipeline.step("seed");
        const workflow = pipeline
            .chat(seed.id, "binding-seed")
            .tts(
                "tts",
                { voice: "alloy", format: "mp3" },
                {
                    source: seed,
                    select: (sourceValue) => `sel:${JSON.stringify(sourceValue)}`
                }
            )
            .transcribe("tx", { responseFormat: "text" }, { source: "tts", select: "audio" })
            .output((values) => ({ out: String(values.tx) }))
            .build();

        const execution = await runner.run(workflow, ctx);
        expect(execution.status).toBe("completed");
        expect(execution.output?.out).toContain("text-from:data:audio/mpeg;");
    });

    it("saveFile falls back to text content when source artifact has no base64", async () => {
        const { runner, ctx } = createPipelineHarness();
        const workflow = new Pipeline<{ kind: string; text: string }>("pipeline-save-text")
            .custom("plain", "customEcho", { input: { value: { text: "plain-text-content" } } })
            .saveFile("save", { path: "out/{{plain}}-{source.id}-{{source.id}}.txt" }, { source: "plain" })
            .output((values) => ({
                kind: String((values.save as any)?.contentType ?? ""),
                text: String((values.save as any)?.text ?? "")
            }))
            .build();

        const execution = await runner.run(workflow, ctx);
        expect(execution.status).toBe("completed");
        expect(execution.output?.kind).toBe("text");
        expect(execution.output?.text).toContain("plain-text-content");
    });

    it("transcribe supports artifact select function", async () => {
        const { runner, ctx } = createPipelineHarness();
        const workflow = new Pipeline<{ out: string }>("pipeline-artifact-select-fn")
            .custom("artifactSeed", "customEcho", {
                input: {
                    value: {
                        id: "artifact-1",
                        mimeType: "audio/mpeg",
                        base64: Buffer.from("seed", "utf8").toString("base64")
                    }
                }
            })
            .transcribe(
                "tx",
                { responseFormat: "text" },
                {
                    source: "artifactSeed",
                    select: () => ({
                        mimeType: "audio/mpeg",
                        base64: Buffer.from("custom-audio", "utf8").toString("base64")
                    })
                }
            )
            .output((values) => ({ out: String(values.tx) }))
            .build();

        const execution = await runner.run(workflow, ctx);
        expect(execution.status).toBe("completed");
        expect(execution.output?.out).toContain("text-from:data:audio/mpeg;");
    });

    it("videoDownload resolves videoUri and videoId from source artifact when omitted", async () => {
        const { runner, ctx } = createPipelineHarness();
        const workflow = new Pipeline<{ id: string; uri: string }>("pipeline-video-download-source")
            .videoGenerate("v", { prompt: "seed video" })
            .videoDownload("d", {}, { source: "v" })
            .output((values) => ({
                id: String((values.d as any)?.[0]?.id ?? ""),
                uri: String((values.d as any)?.[0]?.url ?? "")
            }))
            .build();

        const execution = await runner.run(workflow, ctx);
        expect(execution.status).toBe("completed");
        expect(execution.output?.id).toBe("vid-1");
        expect(execution.output?.uri).toContain("https://example.com/v1.mp4");
    });

    it("videoAnalyze throws when all configured source artifacts are unusable", async () => {
        const { runner, ctx } = createPipelineHarness();
        const workflow = new Pipeline("pipeline-video-analyze-no-source")
            .custom("bad", "customEcho", { input: { value: { id: "bad-only" } } })
            .videoAnalyze("analyze", { prompt: "x" }, { source: ["bad"] })
            .build();

        await expect(runner.run(workflow, ctx)).rejects.toThrow(
            "videoAnalyze could not find a usable video artifact"
        );
    });

    it("ocr throws when source bindings resolve only unusable artifacts", async () => {
        const { runner, ctx } = createPipelineHarness();
        const workflow = new Pipeline("pipeline-ocr-no-usable-artifact")
            .custom("bad", "customEcho", { input: { value: { text: "artifact-without-transport" } } })
            .ocr(
                "ocr",
                { language: "en" },
                {
                    source: "bad",
                    select: () => ({ mimeType: "application/pdf" } as any)
                }
            )
            .build();

        await expect(runner.run(workflow, ctx)).rejects.toThrow(
            "Could not resolve a usable artifact from the configured `source` step(s)."
        );
    });

    it("saveFile throws when no artifact candidate can be resolved from the configured source", async () => {
        const { runner, ctx } = createPipelineHarness();
        const workflow = new Pipeline("pipeline-save-missing-artifact")
            .custom("bad", "customEcho", { input: { value: { text: "seed" } } })
            .saveFile(
                "save",
                { path: "test_data/missing.txt" },
                {
                    source: { step: "bad", select: () => undefined as any }
                }
            )
            .build();

        await expect(runner.run(workflow, ctx)).rejects.toThrow(
            "Could not resolve an artifact from the configured `source` step(s)."
        );
    });

    it("chat supports requestOverrides/inputOverrides function shapes", async () => {
        const { runner, ctx, createCapabilityJob } = createPipelineHarness();
        const workflow = new Pipeline("pipeline-chat-overrides")
            .chat("seed", "override-test", {
                requestOverrides: () => ({ context: { traceId: "trace-1" } }),
                inputOverrides: () => ({ temperature: 0.1 })
            })
            .build();

        const execution = await runner.run(workflow, ctx);
        expect(execution.status).toBe("completed");

        const call = createCapabilityJob.mock.calls.find(([cap]) => cap === CapabilityKeys.ChatCapabilityKey);
        expect(call?.[1]).toMatchObject({
            context: { traceId: "trace-1" },
            input: { temperature: 0.1 }
        });
    });

    it("handles empty dependency refs in after() without crashing at build time", () => {
        const pipeline = new Pipeline("pipeline-empty-ref");
        pipeline.after("" as any, "n1", vi.fn() as any);
        const workflow = pipeline.build();
        const n1 = workflow.nodes.find((n) => n.id === "n1");
        expect(n1).toBeDefined();
    });

    it("imageAnalyze supports select function for image reference resolution", async () => {
        const { runner, ctx } = createPipelineHarness();
        const workflow = new Pipeline<{ out: string }>("pipeline-image-select-fn")
            .imageGenerate("img", { prompt: "generate" })
            .imageAnalyze(
                "analyze",
                {},
                {
                    source: "img",
                    select: (sourceValue) => {
                        const first = (Array.isArray(sourceValue) ? sourceValue[0] : sourceValue) as any;
                        return {
                            id: String(first?.id ?? "img-fallback"),
                            sourceType: "url",
                            url: "https://example.com/override.png"
                        };
                    }
                }
            )
            .output((values) => ({ out: JSON.stringify(values.analyze) }))
            .build();

        const execution = await runner.run(workflow, ctx);
        expect(execution.status).toBe("completed");
        expect(execution.output?.out).toContain("image-analysis:1");
    });

    it("supports source binding object and fallback select resolution", async () => {
        const { runner, ctx } = createPipelineHarness();
        const workflow = new Pipeline<{ out: string }>("pipeline-source-binding")
            .chat("seed", "bind")
            .tts("tts", { voice: "alloy", format: "mp3" }, { source: { step: "seed" }, select: "text" })
            .transcribe("tx", { responseFormat: "text" }, { source: { step: "tts" } as any, select: "audio" })
            .output((values) => ({ out: String(values.tx) }))
            .build();

        const execution = await runner.run(workflow, ctx);
        expect(execution.status).toBe("completed");
        expect(execution.output?.out).toContain("text-from:data:audio/mpeg;");
    });

    it("treats empty-string after as no dependency and falls back to capabilityNode path", async () => {
        const { runner, ctx } = createPipelineHarness();
        const workflow = new Pipeline<{ out: string }>("pipeline-empty-after")
            .chat("seed", "no-deps", { after: "" as any })
            .output((values) => ({ out: JSON.stringify(values.seed) }))
            .build();

        const seedNode = workflow.nodes.find((n) => n.id === "seed");
        expect(seedNode?.dependsOn ?? []).toEqual([]);

        const execution = await runner.run(workflow, ctx);
        expect(execution.status).toBe("completed");
        expect(execution.output?.out).toContain("reply:no-deps");
    });

    it("supports capability helpers with no options (mapStepOptions undefined path)", async () => {
        const { runner, ctx, createCapabilityJob } = createPipelineHarness();
        const workflow = new Pipeline("pipeline-no-opts")
            .custom("x", "customEcho", { input: { value: "v" } })
            .build();

        const execution = await runner.run(workflow, ctx);
        expect(execution.status).toBe("completed");
        const call = createCapabilityJob.mock.calls.find(([cap]) => cap === "customEcho");
        expect(call?.[2]).toMatchObject({
            providerChain: undefined,
            addToManager: undefined
        });
    });

    it("maps `when` into node condition and skips node when false", async () => {
        const { runner, ctx } = createPipelineHarness();
        const workflow = new Pipeline("pipeline-when-skip")
            .chat("seed", "a")
            .chat("skipMe", "b", { after: "seed", when: () => false })
            .build();

        const execution = await runner.run(workflow, ctx);
        expect(execution.status).toBe("completed");
        expect(execution.results.find((r) => r.stepId === "skipMe")?.skipped).toBe(true);
    });

    it("resolves function-based text input for generation helpers", async () => {
        const { runner, ctx, createCapabilityJob } = createPipelineHarness();
        const workflow = new Pipeline("pipeline-function-prompt")
            .chat("seed", "seed-prompt")
            .imageGenerate("img", { prompt: (values) => `from-fn:${JSON.stringify(values.seed)}` }, { after: "seed" })
            .build();

        const execution = await runner.run(workflow, ctx);
        expect(execution.status).toBe("completed");
        const call = createCapabilityJob.mock.calls.find(([cap]) => cap === CapabilityKeys.ImageGenerationCapabilityKey);
        expect(String(call?.[1]?.input?.prompt ?? "")).toContain("from-fn:");
    });

    it("normalizes empty dependency refs in capabilityAfter path", () => {
        const workflow = new Pipeline("pipeline-empty-cap-after")
            .capabilityAfter("" as any, "a", CapabilityKeys.ChatCapabilityKey, {
                input: { messages: [{ role: "user", content: [{ type: "text", text: "x" }] }] }
            })
            .build();

        const node = workflow.nodes.find((n) => n.id === "a");
        expect(node).toBeDefined();
    });

    it("falls back to raw output for unknown normalize preset values", async () => {
        const { runner, ctx } = createPipelineHarness();
        const workflow = new Pipeline<{ hasRole: boolean }>("pipeline-normalize-unknown")
            .chat("seed", "raw-fallback", { normalize: "unknown" as any })
            .output((values) => ({
                hasRole: Boolean((values.seed as any)?.role === "assistant")
            }))
            .build();

        const execution = await runner.run(workflow, ctx);
        expect(execution.status).toBe("completed");
        expect(execution.output?.hasRole).toBe(true);
    });

    it("supports chatStream helper path", async () => {
        const { runner, ctx } = createPipelineHarness();
        const workflow = new Pipeline<{ out: string }>("pipeline-chatstream")
            .chat("seed", "stream-seed")
            .chatStream("streamed", "stream from {{seed}}", { after: "seed" })
            .output((values) => ({ out: JSON.stringify(values.streamed) }))
            .build();

        const execution = await runner.run(workflow, ctx);
        expect(execution.status).toBe("completed");
        expect(execution.output?.out).toContain("reply:stream from");
    });

    it("exercises translate, moderate, and embed helper branches", async () => {
        const { runner, ctx } = createPipelineHarness();
        const workflow = new Pipeline<{
            translated: string;
            flagged: boolean;
            dims: number;
            dims2: number;
        }>("pipeline-translate-moderate-embed")
            .chat("seed", "safe text")
            .tts("audio", { voice: "alloy", format: "mp3", instructions: "slow" }, { source: "seed" })
            .translate(
                "tr",
                {
                    filename: "clip.mp3",
                    targetLanguage: "spanish",
                    responseFormat: "text"
                },
                { source: "audio" }
            )
            .moderate("mod", {}, { source: "tr" })
            .embed("embFromSource", {}, { source: "tr" })
            .embed("embFromText", { text: "manual text", purpose: "search" })
            .output((values) => ({
                translated: String(values.tr),
                flagged: Boolean((values.mod as any)?.[0]?.flagged),
                dims: Number((values.embFromSource as any)?.[0]?.dimensions ?? 0),
                dims2: Number((values.embFromText as any)?.[0]?.dimensions ?? 0)
            }))
            .build();

        const execution = await runner.run(workflow, ctx);
        expect(execution.status).toBe("completed");
        expect(execution.output?.translated).toContain("text-from:");
        expect(execution.output?.flagged).toBe(false);
        expect(execution.output?.dims).toBe(3);
        expect(execution.output?.dims2).toBe(3);
    });

    it("supports videoRemix success with source artifact and prompt/params", async () => {
        const { runner, ctx } = createPipelineHarness();
        const workflow = new Pipeline<{ remixId: string }>("pipeline-video-remix-success")
            .videoGenerate("base", { prompt: "base clip" })
            .videoRemix(
                "remix",
                {
                    prompt: "remix {{base}}",
                    params: { style: "cinematic" }
                },
                { source: "base" }
            )
            .output((values) => ({
                remixId: String((values.remix as any)?.[0]?.id ?? "")
            }))
            .build();

        const execution = await runner.run(workflow, ctx);
        expect(execution.status).toBe("completed");
        expect(execution.output?.remixId).toBe("vid-1-remix");
    });

    it("supports aggregate alias mapper", async () => {
        const { runner, ctx } = createPipelineHarness();
        const workflow = new Pipeline<{ out: string }>("pipeline-aggregate-alias")
            .chat("seed", "aggregate")
            .aggregate((results) => ({ out: String(results.seed ? "ok" : "missing") }))
            .build();

        const execution = await runner.run(workflow, ctx);
        expect(execution.status).toBe("completed");
        expect(execution.output?.out).toBe("ok");
    });

    it("normalizes empty dependency arrays in capabilityAfter", () => {
        const workflow = new Pipeline("pipeline-empty-cap-after-array")
            .capabilityAfter(["" as any, "" as any], "a", CapabilityKeys.ChatCapabilityKey, {
                input: { messages: [{ role: "user", content: [{ type: "text", text: "x" }] }] }
            })
            .build();

        const node = workflow.nodes.find((n) => n.id === "a");
        expect(node).toBeDefined();
        expect(Array.isArray(node?.dependsOn)).toBe(true);
    });

    it("covers helper branches for OCR page extraction and function-based selectors", () => {
        const pipeline = new Pipeline("pipeline-helper-branches") as any;
        const values = {
            seed: { nested: "value" },
            imageSeed: { custom: true }
        };

        expect(
            pipeline.extractOCRText([
                { pages: [{ fullText: "" }, { fullText: " Page one body " }] },
                null,
                { fullText: " Already full text " }
            ])
        ).toBe("Page one body\n\nAlready full text");

        expect(
            pipeline.resolveSourceText(
                { nested: "value" },
                values,
                (sourceValue: any) => `selected:${String(sourceValue.nested)}`
            )
        ).toBe("selected:value");

        expect(
            pipeline.resolveSourceImageReference(
                { ignored: true },
                values,
                (_sourceValue: any) => ({
                    id: "img-custom",
                    sourceType: "url",
                    url: "https://example.com/custom.png"
                })
            )
        ).toEqual({
            id: "img-custom",
            sourceType: "url",
            url: "https://example.com/custom.png"
        });
    });

    it("covers default branches for tts/transcribe/translate helpers", async () => {
        const { runner, ctx, createCapabilityJob } = createPipelineHarness();
        const workflow = new Pipeline("pipeline-default-branches-audio")
            .chat("seed", "defaults")
            .tts("tts", {}, { source: "seed" })
            .transcribe("tx", {}, { source: "tts" })
            .translate("tr", {}, { source: "tts" })
            .build();

        const execution = await runner.run(workflow, ctx);
        expect(execution.status).toBe("completed");

        const txCall = createCapabilityJob.mock.calls.find(([cap]) => cap === CapabilityKeys.AudioTranscriptionCapabilityKey);
        expect(txCall?.[1]).toMatchObject({
            input: {
                filename: "audio-input.mp3",
                responseFormat: "text",
                mimeType: "audio/mpeg"
            }
        });

        const trCall = createCapabilityJob.mock.calls.find(([cap]) => cap === CapabilityKeys.AudioTranslationCapabilityKey);
        expect(trCall?.[1]).toMatchObject({
            input: {
                filename: "audio-input.mp3",
                targetLanguage: "english",
                responseFormat: "text",
                mimeType: "audio/mpeg"
            }
        });
    });

    it("covers optional-source branches for embed and imageGenerate", async () => {
        const { runner, ctx, createCapabilityJob } = createPipelineHarness();
        const workflow = new Pipeline("pipeline-default-branches-image-embed")
            .embed("emb", {})
            .chat("seed", "image-source")
            .imageGenerate("img", {}, { source: "seed", params: undefined as any })
            .build();

        const execution = await runner.run(workflow, ctx);
        expect(execution.status).toBe("completed");

        const embCall = createCapabilityJob.mock.calls.find(([cap]) => cap === CapabilityKeys.EmbedCapabilityKey);
        expect(embCall?.[1]?.input?.input).toBe("");

        const imgCall = createCapabilityJob.mock.calls.find(([cap]) => cap === CapabilityKeys.ImageGenerationCapabilityKey);
        expect(String(imgCall?.[1]?.input?.prompt ?? "")).toContain("reply:image-source");
    });

    it("covers saveFile function-path branch", async () => {
        const { runner, ctx } = createPipelineHarness();
        const workflow = new Pipeline<{ path: string }>("pipeline-save-path-fn")
            .imageGenerate("img", { prompt: "fn-path" })
            .saveFile(
                "save",
                {
                    path: ({ artifact }) => `test_data/${String((artifact as any)?.id ?? "na")}.bin`
                },
                { source: "img" }
            )
            .output((values) => ({ path: String((values.save as any)?.path ?? "") }))
            .build();

        const execution = await runner.run(workflow, ctx);
        expect(execution.status).toBe("completed");
        expect(execution.output?.path).toContain("img-1.bin");
    });

    it("covers video helper defaults and function-based ids", async () => {
        const { runner, ctx, createCapabilityJob } = createPipelineHarness();
        const workflow = new Pipeline("pipeline-video-branch-cases")
            .chat("seed", "video-seed")
            .videoGenerate("vgen", { params: { quality: "low" } }, { source: "seed" })
            .videoRemix(
                "vremix",
                {
                    sourceVideoId: (values) => String((values.vgen as any)?.[0]?.id ?? ""),
                    params: undefined as any
                },
                { source: "vgen" }
            )
            .videoDownload(
                "vdl",
                {
                    videoUri: "https://example.com/source.mp4",
                    videoId: (values) => `dl-${String((values.vremix as any)?.[0]?.id ?? "x")}`,
                    variant: "source"
                },
                {}
            )
            .videoAnalyze("van", { params: { mode: "brief" } }, { source: "vdl" as any })
            .build();

        const execution = await runner.run(workflow, ctx);
        expect(execution.status).toBe("completed");

        const remixCall = createCapabilityJob.mock.calls.find(([cap]) => cap === CapabilityKeys.VideoRemixCapabilityKey);
        expect(remixCall?.[1]?.input?.sourceVideoId).toBe("vid-1");
        expect(remixCall?.[1]?.input?.prompt).toBeUndefined();

        const downloadCall = createCapabilityJob.mock.calls.find(([cap]) => cap === CapabilityKeys.VideoDownloadCapabilityKey);
        expect(downloadCall?.[1]).toMatchObject({
            input: {
                variant: "source"
            }
        });
        expect(String(downloadCall?.[1]?.input?.videoId ?? "")).toContain("dl-");
    });

    it("covers non-function request/input override resolution path", async () => {
        const { runner, ctx, createCapabilityJob } = createPipelineHarness();
        const workflow = new Pipeline("pipeline-chat-overrides-object")
            .chat("seed", "override-obj", {
                requestOverrides: { context: { traceId: "obj-1" } },
                inputOverrides: { temperature: 0.2 }
            })
            .build();

        const execution = await runner.run(workflow, ctx);
        expect(execution.status).toBe("completed");

        const call = createCapabilityJob.mock.calls.find(([cap]) => cap === CapabilityKeys.ChatCapabilityKey);
        expect(call?.[1]).toMatchObject({
            context: { traceId: "obj-1" },
            input: { temperature: 0.2 }
        });
    });
});
