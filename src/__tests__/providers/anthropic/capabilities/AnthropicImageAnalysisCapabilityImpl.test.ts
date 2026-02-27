import { describe, expect, it, vi } from "vitest";
import { AnthropicImageAnalysisCapabilityImpl } from "#root/providers/anthropic/capabilities/AnthropicImageAnalysisCapabilityImpl.js";
import { MultiModalExecutionContext } from "#root/index.js";

function makeProvider() {
    return {
        ensureInitialized: vi.fn(),
        getMergedOptions: vi.fn(() => ({ model: "claude-vision", modelParams: {}, providerParams: {} }))
    } as any;
}

const base64Image = { id: "img1", sourceType: "base64", base64: "QQ==", mimeType: "image/png" } as any;

describe("AnthropicImageAnalysisCapabilityImpl", () => {
    it("validates required images for non-stream and stream", async () => {
        const cap = new AnthropicImageAnalysisCapabilityImpl(makeProvider(), { messages: {} } as any);

        await expect(cap.analyzeImage({ input: {} } as any, new MultiModalExecutionContext())).rejects.toThrow(
            "At least one image"
        );
        await expect(cap.analyzeImageStream({ input: {} } as any, new MultiModalExecutionContext()).next()).rejects.toThrow(
            "At least one image"
        );
    });

    it("aborts analyzeImage before request starts", async () => {
        const controller = new AbortController();
        controller.abort();
        const cap = new AnthropicImageAnalysisCapabilityImpl(makeProvider(), { messages: {} } as any);

        await expect(
            cap.analyzeImage({ input: { images: [base64Image] } } as any, new MultiModalExecutionContext(), controller.signal)
        ).rejects.toThrow("Image analysis aborted before request started");
    });

    it("analyzeImage parses fenced JSON into normalized analyses", async () => {
        const client = {
            messages: {
                create: vi.fn().mockResolvedValue({
                    content: [
                        {
                            type: "text",
                            text: `\`\`\`json
[{"description":"cat on sofa","tags":["cat","sofa"],"safety":"safe"}]
\`\`\``
                        }
                    ]
                })
            }
        };

        const cap = new AnthropicImageAnalysisCapabilityImpl(makeProvider(), client as any);
        const res = await cap.analyzeImage({ input: { images: [base64Image] }, context: { requestId: "r1" } } as any);

        expect(res.output).toHaveLength(1);
        expect(res.output[0].sourceImageId).toBe("img1");
        expect(res.output[0].description).toBe("cat on sofa");
        expect(res.output[0].tags).toContain("cat");
        expect(res.output[0].safety?.flagged).toBe(false);
        expect(res.metadata?.requestId).toBe("r1");
    });

    it("analyzeImage stops after first image when signal aborts mid-loop", async () => {
        const controller = new AbortController();
        const client = {
            messages: {
                create: vi.fn().mockImplementation(async () => {
                    controller.abort();
                    return { content: [{ type: "text", text: '{"description":"one"}' }] };
                })
            }
        };
        const cap = new AnthropicImageAnalysisCapabilityImpl(makeProvider(), client as any);
        const res = await cap.analyzeImage(
            { input: { images: [base64Image, { ...base64Image, id: "img2" }] } } as any,
            new MultiModalExecutionContext(),
            controller.signal
        );

        expect(res.output).toHaveLength(1);
        expect(client.messages.create).toHaveBeenCalledTimes(1);
    });

    it("analyzeImageStream emits partial, completed, and error chunks", async () => {
        const okStream = {
            async *[Symbol.asyncIterator]() {
                yield { type: "message_start", message: { id: "mid" } };
                yield {
                    type: "content_block_delta",
                    delta: { type: "text_delta", text: '[{"description":"dog","tags":["dog"],"safety":"safe"}]' }
                };
            }
        };

        const client = {
            messages: {
                stream: vi
                    .fn()
                    .mockResolvedValueOnce(okStream)
                    .mockResolvedValueOnce(Promise.reject(new Error("stream boom")))
            }
        };
        const cap = new AnthropicImageAnalysisCapabilityImpl(makeProvider(), client as any);

        const req = {
            input: {
                images: [base64Image, { ...base64Image, id: "img2" }]
            }
        } as any;

        const chunks: any[] = [];
        for await (const chunk of cap.analyzeImageStream(req, new MultiModalExecutionContext())) {
            chunks.push(chunk);
        }

        expect(chunks[0].metadata.status).toBe("incomplete");
        expect(chunks[1].metadata.status).toBe("completed");
        expect(chunks[1].done).toBe(true);
        expect(chunks[2].metadata.status).toBe("error");
        expect(chunks[2].metadata.sourceImageId).toBe("img2");
    });

    it("analyzeImageStream exits silently when aborted", async () => {
        const streamObj = {
            async *[Symbol.asyncIterator]() {
                yield { type: "message_start", message: { id: "mid" } };
            }
        };
        const client = {
            messages: {
                stream: vi.fn().mockResolvedValue(streamObj)
            }
        };
        const cap = new AnthropicImageAnalysisCapabilityImpl(makeProvider(), client as any);
        const controller = new AbortController();
        controller.abort();

        const out = await cap.analyzeImageStream(
            { input: { images: [base64Image] } } as any,
            new MultiModalExecutionContext(),
            controller.signal
        ).next();
        expect(out.done).toBe(true);
        expect(out.value).toBeUndefined();
    });

    it("helper methods validate image source and recover fallback tags/objects", () => {
        const cap = new AnthropicImageAnalysisCapabilityImpl(makeProvider(), { messages: {} } as any) as any;

        expect(() =>
            cap.buildVisionMessages("prompt", [{ sourceType: "url", url: "https://x" }])
        ).toThrow("Anthropic vision requires base64 images");

        const normalized = cap.normalizeAnalyses({ foo: ["orange cat", "window sill"], safety: "unsafe" }, "img3");
        expect(normalized[0].tags).toContain("orange cat");
        expect(normalized[0].objects?.[0]?.label).toBeDefined();
        expect(normalized[0].safety.flagged).toBe(true);

        expect(
            cap
                .stripJsonFences(`\`\`\`json
{"a":1}
\`\`\``)
                .trim()
        ).toBe('{"a":1}');
    });

    it("helper methods cover prompt guard, description text, and object filtering", () => {
        const cap = new AnthropicImageAnalysisCapabilityImpl(makeProvider(), { messages: {} } as any) as any;

        expect(() => cap.buildVisionMessages("", [])).toThrow("Vision prompt is required");

        const built = cap.buildVisionMessages("prompt", [{ ...base64Image, description: "desc" }]);
        expect(built[0].content.some((c: any) => c.type === "text" && c.text === "desc")).toBe(true);

        expect(cap.normalizeAnalyses(null, "img")).toEqual([]);
        const normalized = cap.normalizeAnalyses(
            { description: "a,b", objects: [{ label: "ok" }, { nope: true }], safety: "safe" },
            "img"
        );
        expect(normalized[0].objects).toEqual([{ label: "ok" }]);
    });
});
