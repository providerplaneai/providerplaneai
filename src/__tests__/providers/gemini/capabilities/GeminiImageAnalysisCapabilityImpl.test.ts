import { describe, expect, it, vi } from "vitest";
import { GeminiImageAnalysisCapabilityImpl } from "#root/providers/gemini/capabilities/GeminiImageAnalysisCapabilityImpl.js";
import { MultiModalExecutionContext } from "#root/index.js";

function makeProvider() {
    return {
        ensureInitialized: vi.fn(),
        getMergedOptions: vi.fn(() => ({ model: "gemini-2.5-pro", modelParams: {}, providerParams: {} }))
    } as any;
}

const img = { id: "i1", base64: "QQ==", mimeType: "image/png" } as any;

describe("GeminiImageAnalysisCapabilityImpl", () => {
    it("requires at least one image", async () => {
        const cap = new GeminiImageAnalysisCapabilityImpl(makeProvider(), { models: {} } as any);
        await expect(cap.analyzeImage({ input: {} } as any, new MultiModalExecutionContext())).rejects.toThrow(
            "At least one image"
        );
        await expect(cap.analyzeImageStream({ input: {} } as any, new MultiModalExecutionContext()).next()).rejects.toThrow(
            "At least one image"
        );
    });

    it("analyzeImage uses executionContext latest images when input images missing", async () => {
        const client = {
            models: {
                generateContent: vi.fn().mockResolvedValue({
                    text: '{"description":"scene","tags":["tag1"],"safety":{"flagged":false}}',
                    responseId: "resp-1"
                })
            }
        };
        const cap = new GeminiImageAnalysisCapabilityImpl(makeProvider(), client as any);

        const ctx = new MultiModalExecutionContext();
        ctx.attachArtifacts({ images: [img] as any });

        const res = await cap.analyzeImage({ input: {} } as any, ctx);
        expect(res.output).toHaveLength(1);
        expect(res.output[0].description).toBe("scene");
        expect(res.metadata?.countsMatch).toBe(true);
    });

    it("analyzeImage uses default model and reports counts mismatch when parsed length differs", async () => {
        const provider = {
            ensureInitialized: vi.fn(),
            getMergedOptions: vi.fn(() => ({ model: undefined, modelParams: undefined, providerParams: undefined }))
        } as any;
        const client = {
            models: {
                generateContent: vi.fn().mockResolvedValue({
                    text: '{"description":"only-one"}',
                    responseId: undefined
                })
            }
        };
        const cap = new GeminiImageAnalysisCapabilityImpl(provider, client as any);

        const res = await cap.analyzeImage({ input: { images: [img, { ...img, id: "i2" }] }, context: { requestId: "rq" } } as any);
        expect(client.models.generateContent.mock.calls[0][0].model).toBe("gemini-2.5-pro");
        expect(res.id).toBe("rq");
        expect(res.metadata?.countsMatch).toBe(false);
    });

    it("analyzeImage aborts when signal is aborted", async () => {
        const cap = new GeminiImageAnalysisCapabilityImpl(makeProvider(), { models: {} } as any);
        const controller = new AbortController();
        controller.abort();
        await expect(cap.analyzeImage({ input: { images: [img] } } as any, undefined, controller.signal)).rejects.toThrow(
            "Request aborted"
        );
    });

    it("analyzeImageStream emits completion chunk and handles stream errors", async () => {
        const okStream = {
            async *[Symbol.asyncIterator]() {
                yield { text: '{"description":"dog"', responseId: "s1" };
                yield { text: ',"tags":["pet"],"safety":{"flagged":false}}', responseId: "s1" };
            }
        };

        const client = {
            models: {
                generateContentStream: vi
                    .fn()
                    .mockResolvedValueOnce(okStream)
                    .mockRejectedValueOnce(new Error("stream fail"))
            }
        };

        const cap = new GeminiImageAnalysisCapabilityImpl(makeProvider(), client as any);

        const first = await cap.analyzeImageStream({ input: { images: [img] }, context: { requestId: "r" } } as any).next();
        expect(first.value?.done).toBe(true);
        expect(first.value?.metadata?.status).toBe("completed");
        expect(first.value?.output[0].description).toBe("dog");

        const second = await cap.analyzeImageStream({ input: { images: [img] } } as any).next();
        expect(second.value?.done).toBe(true);
        expect(second.value?.metadata?.status).toBe("error");
    });

    it("analyzeImageStream tolerates empty text chunks and falls back to generated id", async () => {
        const streamObj = {
            async *[Symbol.asyncIterator]() {
                yield { text: "", responseId: undefined };
            }
        };
        const provider = {
            ensureInitialized: vi.fn(),
            getMergedOptions: vi.fn(() => ({ model: undefined, modelParams: undefined, providerParams: undefined }))
        } as any;
        const client = {
            models: {
                generateContentStream: vi.fn().mockResolvedValue(streamObj)
            }
        };
        const cap = new GeminiImageAnalysisCapabilityImpl(provider, client as any);
        const out = await cap.analyzeImageStream({ input: { images: [img] } } as any).next();

        expect(out.value?.done).toBe(true);
        expect(out.value?.id).toBeDefined();
        expect(out.value?.metadata?.countsMatch).toBe(false);
    });

    it("analyzeImageStream exits silently when request is aborted", async () => {
        const streamObj = {
            async *[Symbol.asyncIterator]() {
                yield { text: '{"description":"dog"}', responseId: "s1" };
            }
        };
        const client = {
            models: {
                generateContentStream: vi.fn().mockResolvedValue(streamObj)
            }
        };

        const cap = new GeminiImageAnalysisCapabilityImpl(makeProvider(), client as any);
        const controller = new AbortController();
        controller.abort();

        const out = await cap.analyzeImageStream(
            { input: { images: [img] } } as any,
            new MultiModalExecutionContext(),
            controller.signal
        ).next();
        expect(out.done).toBe(true);
        expect(out.value).toBeUndefined();
    });

    it("normalizeGeminiAnalyses applies defaults and provider safety metadata", () => {
        const cap = new GeminiImageAnalysisCapabilityImpl(makeProvider(), { models: {} } as any) as any;
        const out = cap.normalizeGeminiAnalyses({ description: "x" }, [img]);
        expect(out[0].id).toBe("i1");
        expect(out[0].safety.provider).toBe("gemini");
        expect(out[0].safety.flagged).toBe(false);
    });

    it("normalizeGeminiAnalyses preserves text confidence entries", () => {
        const cap = new GeminiImageAnalysisCapabilityImpl(makeProvider(), { models: {} } as any) as any;
        const out = cap.normalizeGeminiAnalyses({ description: "x", text: [{ text: "word", confidence: 0.8 }] }, [img]);
        expect(out[0].text?.[0]).toEqual({ text: "word", confidence: 0.8 });
    });

    it("toGeminiImagePart handles base64, data-url, file-url and throws for invalid input", () => {
        const cap = new GeminiImageAnalysisCapabilityImpl(makeProvider(), { models: {} } as any) as any;

        const fromBase64 = cap.toGeminiImagePart({
            base64: "data:image/png;base64,QUJD",
            mimeType: "image/png"
        });
        expect(fromBase64.inlineData.mimeType).toBe("image/png");
        expect(fromBase64.inlineData.data).toBe("QUJD");

        const fromDataUrl = cap.toGeminiImagePart({
            url: "data:image/jpeg;base64,REVG",
            mimeType: "image/png"
        });
        expect(fromDataUrl.inlineData.mimeType).toBe("image/jpeg");
        expect(fromDataUrl.inlineData.data).toBe("REVG");

        const fromFileUrl = cap.toGeminiImagePart({
            url: "https://example.com/image.png",
            mimeType: "image/webp"
        });
        expect(fromFileUrl.fileData.fileUri).toBe("https://example.com/image.png");
        expect(fromFileUrl.fileData.mimeType).toBe("image/webp");

        expect(() => cap.toGeminiImagePart({ mimeType: "image/png" })).toThrow(
            "Gemini image analysis requires image.base64 or image.url"
        );
    });

    it("extractGeminiResponseText falls back to candidates and stripMarkdownCodeFence removes json fences", () => {
        const cap = new GeminiImageAnalysisCapabilityImpl(makeProvider(), { models: {} } as any) as any;

        const fromCandidates = cap.extractGeminiResponseText({
            candidates: [
                { content: { parts: [{ text: "first" }, { text: "second" }, { other: 1 }] } },
                { content: { parts: [{ text: "third" }] } }
            ]
        });
        expect(fromCandidates).toBe("first\nsecond\nthird");

        const stripped = cap.stripMarkdownCodeFence("```json\n{\"description\":\"scene\"}\n```");
        expect(stripped).toBe("{\"description\":\"scene\"}");
    });

    it("normalizeGeminiAnalyses falls back to raw text when parsed payload is effectively empty", () => {
        const cap = new GeminiImageAnalysisCapabilityImpl(makeProvider(), { models: {} } as any) as any;
        const out = cap.normalizeGeminiAnalyses({}, [img], "raw response text");
        expect(out[0].description).toBe("raw response text");
        expect(out[0].id).toBe("i1");
    });
});
