import { describe, expect, it, vi } from "vitest";
import { OpenAIImageAnalysisCapabilityImpl } from "#root/providers/openai/capabilities/OpenAIImageAnalysisCapabilityImpl.js";
import { MultiModalExecutionContext } from "#root/index.js";

function makeProvider() {
    return {
        ensureInitialized: vi.fn(),
        getMergedOptions: vi.fn(() => ({ model: "gpt-4.1", modelParams: {}, providerParams: {} }))
    } as any;
}

const img = { id: "i1", base64: "QQ==", mimeType: "image/png" } as any;

describe("OpenAIImageAnalysisCapabilityImpl", () => {
    it("validates images and schema guards", async () => {
        const cap = new OpenAIImageAnalysisCapabilityImpl(makeProvider(), { responses: {} } as any);

        await expect(cap.analyzeImage({ input: {} } as any, new MultiModalExecutionContext())).rejects.toThrow(
            "At least one image"
        );

        const schemaBackup = OpenAIImageAnalysisCapabilityImpl.OPENAI_IMAGE_ANALYSIS_SCHEMA;
        (OpenAIImageAnalysisCapabilityImpl as any).OPENAI_IMAGE_ANALYSIS_SCHEMA = { type: "array" };
        await expect(cap.analyzeImage({ input: { images: [img] } } as any, new MultiModalExecutionContext())).rejects.toThrow(
            "Invalid OpenAI function schema"
        );
        (OpenAIImageAnalysisCapabilityImpl as any).OPENAI_IMAGE_ANALYSIS_SCHEMA = schemaBackup;
    });

    it("aborts analyzeImage before request starts", async () => {
        const cap = new OpenAIImageAnalysisCapabilityImpl(makeProvider(), { responses: {} } as any);
        const controller = new AbortController();
        controller.abort();

        await expect(
            cap.analyzeImage({ input: { images: [img] } } as any, new MultiModalExecutionContext(), controller.signal)
        ).rejects.toThrow("aborted before request started");
    });

    it("analyzeImage parses function_call output and ignores invalid items", async () => {
        const client = {
            responses: {
                create: vi.fn().mockResolvedValue({
                    id: "rid",
                    status: "completed",
                    output: [
                        { type: "message", role: "assistant" },
                        { type: "function_call", name: "other", arguments: "{}" },
                        {
                            type: "function_call",
                            name: "image_analysis",
                            arguments: '{"description":"cat","tags":["pet"],"objects":[{"label":"cat"}],"text":[{"text":"hi"}],"safety":{"flagged":true}}'
                        }
                    ]
                })
            }
        };
        const cap = new OpenAIImageAnalysisCapabilityImpl(makeProvider(), client as any);

        const res = await cap.analyzeImage({ input: { images: [img] }, context: { requestId: "r1" } } as any, new MultiModalExecutionContext());
        expect(res.output).toHaveLength(1);
        expect(res.output[0].description).toBe("cat");
        expect(res.output[0].safety?.flagged).toBe(true);
        expect(res.metadata?.requestId).toBe("r1");
    });

    it("analyzeImage falls back to context requestId when response id is missing", async () => {
        const client = {
            responses: {
                create: vi.fn().mockResolvedValue({
                    id: undefined,
                    status: undefined,
                    output: [{ type: "function_call", name: "image_analysis", arguments: "{}" }]
                })
            }
        };
        const cap = new OpenAIImageAnalysisCapabilityImpl(makeProvider(), client as any);
        const res = await cap.analyzeImage(
            { input: { images: [img] }, context: { requestId: "fallback-id" } } as any,
            new MultiModalExecutionContext()
        );

        expect(res.id).toBe("fallback-id");
        expect(res.metadata?.status).toBe("completed");
    });

    it("analyzeImage uses default model/options and falls back to generated id", async () => {
        const provider = {
            ensureInitialized: vi.fn(),
            getMergedOptions: vi.fn(() => ({ model: undefined, modelParams: undefined, providerParams: undefined }))
        } as any;
        const client = {
            responses: {
                create: vi.fn().mockResolvedValue({
                    id: undefined,
                    status: "ok",
                    output: undefined
                })
            }
        };
        const cap = new OpenAIImageAnalysisCapabilityImpl(provider, client as any);
        const res = await cap.analyzeImage({ input: { images: [img] } } as any, new MultiModalExecutionContext());
        const call = client.responses.create.mock.calls[0][0];

        expect(call.model).toBe("gpt-4.1");
        expect(call.tool_choice.name).toBe("image_analysis");
        expect(res.id).toBeDefined();
    });

    it("analyzeImageStream yields completed chunk and error chunk", async () => {
        const okStream = {
            async *[Symbol.asyncIterator]() {
                yield { type: "response.created", response: { id: "sid" } };
                yield {
                    type: "response.output_item.done",
                    item: {
                        type: "function_call",
                        name: "image_analysis",
                        arguments: '[{"description":"dog","safety":{"flagged":false}}]'
                    }
                };
            }
        };

        const client = {
            responses: {
                stream: vi.fn().mockReturnValueOnce(okStream).mockImplementationOnce(() => {
                    throw new Error("stream fail");
                })
            }
        };

        const cap = new OpenAIImageAnalysisCapabilityImpl(makeProvider(), client as any);

        const first = await cap.analyzeImageStream({ input: { images: [img] }, context: { requestId: "r" } } as any).next();
        expect(first.value?.done).toBe(true);
        expect(first.value?.metadata?.status).toBe("completed");
        expect(first.value?.output[0].description).toBe("dog");

        const second = await cap.analyzeImageStream({ input: { images: [img] } } as any).next();
        expect(second.value?.done).toBe(true);
        expect(second.value?.metadata?.status).toBe("error");
    });

    it("analyzeImageStream skips unrelated events and function calls", async () => {
        const streamObj = {
            async *[Symbol.asyncIterator]() {
                yield { type: "response.completed", response: { id: "sid-2" } };
                yield { type: "response.output_item.done", item: { type: "function_call", name: "other", arguments: "{}" } };
            }
        };
        const client = {
            responses: {
                stream: vi.fn().mockReturnValue(streamObj)
            }
        };
        const cap = new OpenAIImageAnalysisCapabilityImpl(makeProvider(), client as any);

        const all: any[] = [];
        for await (const c of cap.analyzeImageStream({ input: { images: [img] } } as any)) {
            all.push(c);
        }
        expect(all).toEqual([]);
    });

    it("analyzeImageStream yields error chunk on malformed streamed function arguments", async () => {
        const badStream = {
            async *[Symbol.asyncIterator]() {
                yield { type: "response.created", response: { id: "sid-bad" } };
                yield {
                    type: "response.output_item.done",
                    item: { type: "function_call", name: "image_analysis", arguments: "{bad-json" }
                };
            }
        };
        const client = { responses: { stream: vi.fn().mockReturnValue(badStream) } };
        const cap = new OpenAIImageAnalysisCapabilityImpl(makeProvider(), client as any);

        const first = await cap.analyzeImageStream({ input: { images: [img] } } as any).next();
        expect(first.value?.done).toBe(true);
        expect(first.value?.metadata?.status).toBe("error");
    });

    it("analyzeImageStream supports context-image fallback and requestId id fallback", async () => {
        const streamObj = {
            async *[Symbol.asyncIterator]() {
                yield {
                    type: "response.output_item.done",
                    item: { type: "function_call", name: "image_analysis", arguments: '{"description":"x"}' }
                };
            }
        };
        const provider = {
            ensureInitialized: vi.fn(),
            getMergedOptions: vi.fn(() => ({ model: undefined, modelParams: undefined, providerParams: undefined }))
        } as any;
        const client = { responses: { stream: vi.fn().mockReturnValue(streamObj) } };
        const cap = new OpenAIImageAnalysisCapabilityImpl(provider, client as any);
        const ctx = new MultiModalExecutionContext();
        ctx.attachArtifacts({ images: [img] as any });

        const out = await cap.analyzeImageStream({ input: {}, context: { requestId: "rid" } } as any, ctx).next();
        expect(out.value?.id).toBe("rid");
        expect(out.value?.metadata?.model).toBeUndefined();
    });

    it("normalizeAnalyses handles nullish payload and missing safety", () => {
        const cap = new OpenAIImageAnalysisCapabilityImpl(makeProvider(), { responses: {} } as any) as any;
        expect(cap.normalizeAnalyses(null)).toEqual([]);
        const out = cap.normalizeAnalyses({ description: "x", tags: [""], safety: undefined });
        expect(out[0].safety).toBeUndefined();
        expect(out[0].tags).toEqual([]);
    });

    it("analyzeImageStream validates schema and exits on aborted signal", async () => {
        const schemaBackup = OpenAIImageAnalysisCapabilityImpl.OPENAI_IMAGE_ANALYSIS_SCHEMA;
        (OpenAIImageAnalysisCapabilityImpl as any).OPENAI_IMAGE_ANALYSIS_SCHEMA = { type: "array" };

        const cap = new OpenAIImageAnalysisCapabilityImpl(makeProvider(), { responses: {} } as any);
        await expect(cap.analyzeImageStream({ input: { images: [img] } } as any).next()).rejects.toThrow("Invalid OpenAI function schema");

        (OpenAIImageAnalysisCapabilityImpl as any).OPENAI_IMAGE_ANALYSIS_SCHEMA = schemaBackup;

        const controller = new AbortController();
        const streamClient = {
            responses: {
                stream: vi.fn().mockReturnValue({
                    async *[Symbol.asyncIterator]() {
                        yield { type: "response.created", response: { id: "sid" } };
                    }
                })
            }
        };
        const abortingCap = new OpenAIImageAnalysisCapabilityImpl(makeProvider(), streamClient as any);
        controller.abort();

        const out = await abortingCap.analyzeImageStream(
            { input: { images: [img] } } as any,
            new MultiModalExecutionContext(),
            controller.signal
        ).next();
        expect(out.done).toBe(true);
        expect(out.value).toBeUndefined();
    });
});
