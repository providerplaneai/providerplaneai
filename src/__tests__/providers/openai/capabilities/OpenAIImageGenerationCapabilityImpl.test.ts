import { describe, expect, it, vi } from "vitest";
import { OpenAIImageGenerationCapabilityImpl } from "#root/providers/openai/capabilities/OpenAIImageGenerationCapabilityImpl.js";

function makeProvider() {
    return {
        ensureInitialized: vi.fn(),
        getMergedOptions: vi.fn(() => ({ model: "gpt-4.1", modelParams: {}, providerParams: {} }))
    } as any;
}

describe("OpenAIImageGenerationCapabilityImpl", () => {
    it("validates missing prompt and pre-aborted signal", async () => {
        const cap = new OpenAIImageGenerationCapabilityImpl(makeProvider(), { responses: {} } as any);

        await expect(cap.generateImage({ input: {} } as any)).rejects.toThrow("Prompt is required for image generation");
        await expect(cap.generateImageStream({ input: {} } as any).next()).rejects.toThrow("Prompt is required for image generation");

        const controller = new AbortController();
        controller.abort();
        await expect(cap.generateImage({ input: { prompt: "x" } } as any, undefined, controller.signal)).rejects.toThrow(
            "Image generation aborted before request started"
        );
    });

    it("generateImage parses image_generation_call output", async () => {
        const client = {
            responses: {
                create: vi.fn().mockResolvedValue({
                    id: "img-resp",
                    status: "completed",
                    output: [
                        { type: "image_generation_call", id: "a", result: "QUJD" },
                        { type: "image_generation_call", id: "b", image_base64: "REVG" },
                        { type: "other" }
                    ]
                })
            }
        };

        const cap = new OpenAIImageGenerationCapabilityImpl(makeProvider(), client as any);
        const res = await cap.generateImage({ input: { prompt: "draw" }, context: { requestId: "rid" } } as any);

        expect(res.output).toHaveLength(2);
        expect(res.output[0].base64).toBe("QUJD");
        expect(res.output[0].url).toContain("data:image/png;base64,QUJD");
        expect(res.metadata?.provider).toBe("openai");
        expect(res.metadata?.requestId).toBe("rid");
    });

    it("generateImage uses fallback id from request context when response id missing", async () => {
        const client = {
            responses: {
                create: vi.fn().mockResolvedValue({
                    id: undefined,
                    status: undefined,
                    output: [{ type: "image_generation_call", id: "a", result: "QUJD" }]
                })
            }
        };
        const cap = new OpenAIImageGenerationCapabilityImpl(makeProvider(), client as any);
        const res = await cap.generateImage({ input: { prompt: "draw" }, context: { requestId: "req-1" } } as any);

        expect(res.id).toBe("req-1");
        expect(res.metadata?.status).toBe("completed");
    });

    it("generateImageStream returns silently when aborted after stream error", async () => {
        const controller = new AbortController();
        const client = {
            responses: {
                stream: vi.fn().mockImplementation(() => {
                    controller.abort();
                    throw new Error("broken");
                })
            }
        };
        const cap = new OpenAIImageGenerationCapabilityImpl(makeProvider(), client as any);
        const out = await cap.generateImageStream({ input: { prompt: "draw" } } as any, undefined, controller.signal).next();

        expect(out.done).toBe(true);
        expect(out.value).toBeUndefined();
    });

    it("generateImageStream yields image chunks + completion and error chunk", async () => {
        const okStream = {
            async *[Symbol.asyncIterator]() {
                yield { type: "response.created", response: { id: "sid" } };
                yield {
                    type: "response.completed",
                    response: {
                        id: "sid",
                        output: [
                            { type: "image_generation_call", id: "i1", result: "QUJD" },
                            { type: "image_generation_call", id: "i2", b64_json: "REVG" }
                        ]
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

        const cap = new OpenAIImageGenerationCapabilityImpl(makeProvider(), client as any);
        const out: any[] = [];
        for await (const c of cap.generateImageStream({ input: { prompt: "draw" } } as any)) {
            out.push(c);
        }

        expect(out).toHaveLength(3);
        expect(out[0].metadata.status).toBe("incomplete");
        expect(out[0].output[0].base64).toBe("QUJD");
        expect(out[1].output[0].base64).toBe("REVG");
        expect(out[2].done).toBe(true);

        const errFirst = await cap.generateImageStream({ input: { prompt: "draw" } } as any).next();
        expect(errFirst.value?.metadata?.status).toBe("error");
    });

    it("generateImageStream can end without response id and exits silently when aborted", async () => {
        const noIdStream = {
            async *[Symbol.asyncIterator]() {
                yield { type: "response.completed", response: { output: [] } };
            }
        };
        const client = {
            responses: {
                stream: vi.fn().mockReturnValue(noIdStream)
            }
        };
        const cap = new OpenAIImageGenerationCapabilityImpl(makeProvider(), client as any);

        const out: any[] = [];
        for await (const c of cap.generateImageStream({ input: { prompt: "draw" } } as any)) {
            out.push(c);
        }
        expect(out).toHaveLength(1);
        expect(out[0].done).toBe(true);
        expect(out[0].id).toBeDefined();

        const controller = new AbortController();
        controller.abort();
        const abortedClient = {
            responses: {
                stream: vi.fn().mockReturnValue(noIdStream)
            }
        };
        const abortedCap = new OpenAIImageGenerationCapabilityImpl(makeProvider(), abortedClient as any);
        const aborted = await abortedCap.generateImageStream({ input: { prompt: "draw" } } as any, undefined, controller.signal).next();
        expect(aborted.done).toBe(true);
        expect(aborted.value).toBeUndefined();
    });

    it("generateImageStream ignores non-completed events before final marker", async () => {
        const streamObj = {
            async *[Symbol.asyncIterator]() {
                yield { type: "response.created", response: { id: "sid" } };
                yield { type: "response.in_progress" };
            }
        };
        const client = { responses: { stream: vi.fn().mockReturnValue(streamObj) } };
        const cap = new OpenAIImageGenerationCapabilityImpl(makeProvider(), client as any);

        const out: any[] = [];
        for await (const c of cap.generateImageStream({ input: { prompt: "draw" } } as any)) {
            out.push(c);
        }

        expect(out).toHaveLength(1);
        expect(out[0].done).toBe(true);
    });

    it("buildContent adds reference images and default description wrapper", () => {
        const cap = new OpenAIImageGenerationCapabilityImpl(makeProvider(), { responses: {} } as any) as any;
        const content = cap.buildContent({
            prompt: "draw sky",
            referenceImages: [{ url: "https://example.com/a.png" }]
        });

        expect(content[0]).toMatchObject({ type: "input_image" });
        expect(content[1].text).toContain("Description: draw sky");
    });

    it("parseImages drops image_generation_call items without usable base64", () => {
        const cap = new OpenAIImageGenerationCapabilityImpl(makeProvider(), { responses: {} } as any) as any;
        const images = cap.parseImages([{ type: "image_generation_call", id: "x" }]);
        expect(images).toEqual([]);
    });
});
