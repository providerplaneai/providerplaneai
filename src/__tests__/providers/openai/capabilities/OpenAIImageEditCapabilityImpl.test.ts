import { describe, expect, it, vi } from "vitest";
import { OpenAIImageEditCapabilityImpl } from "#root/providers/openai/capabilities/OpenAIImageEditCapabilityImpl.js";
import { MultiModalExecutionContext } from "#root/index.js";

function makeProvider() {
    return {
        ensureInitialized: vi.fn(),
        getMergedOptions: vi.fn(() => ({ model: "gpt-4.1", modelParams: {}, providerParams: {} }))
    } as any;
}

describe("OpenAIImageEditCapabilityImpl", () => {
    it("validates missing prompt and missing subject image", async () => {
        const cap = new OpenAIImageEditCapabilityImpl(makeProvider(), { responses: {} } as any);
        const ctx = new MultiModalExecutionContext();

        await expect(cap.editImage({ input: {} } as any, ctx)).rejects.toThrow("Edit prompt is required");
        await expect(cap.editImageStream({ input: {} } as any, ctx).next()).rejects.toThrow("Edit prompt is required");
        await expect(cap.editImage({ input: { prompt: "edit" } } as any, ctx)).rejects.toThrow("subject image");
    });

    it("throws when editImage starts with an aborted signal", async () => {
        const cap = new OpenAIImageEditCapabilityImpl(makeProvider(), { responses: {} } as any);
        const controller = new AbortController();
        controller.abort();

        await expect(
            cap.editImage(
                { input: { prompt: "edit", referenceImages: [{ role: "subject", base64: "SU1H", mimeType: "image/png" }] } } as any,
                new MultiModalExecutionContext(),
                controller.signal
            )
        ).rejects.toThrow("aborted before request started");
    });

    it("editImage normalizes output images and masks", async () => {
        const client = {
            responses: {
                create: vi.fn().mockResolvedValue({
                    id: "ed1",
                    output: [
                        { type: "image_generation_call", id: "x", result: "QUJD" },
                        { type: "image_generation_call", id: "y", result: ["REVG", 1] }
                    ]
                })
            }
        };

        const cap = new OpenAIImageEditCapabilityImpl(makeProvider(), client as any);
        const ctx = new MultiModalExecutionContext();
        const res = await cap.editImage(
            {
                input: {
                    prompt: "edit",
                    referenceImages: [
                        { role: "subject", base64: "SU1H", mimeType: "image/png" },
                        { role: "mask", id: "m1", base64: "TUFTSw==", mimeType: "image/png", extras: { targetImageId: "x" } }
                    ]
                },
                context: { requestId: "rid" }
            } as any,
            ctx
        );

        expect(res.output).toHaveLength(2);
        expect(res.output[0].base64).toBe("QUJD");
        expect(res.multimodalArtifacts?.masks?.[0].id).toBe("m1");
        expect(res.metadata?.requestId).toBe("rid");
    });

    it("editImage handles empty output and generates fallback id when response id is missing", async () => {
        const client = {
            responses: {
                create: vi.fn().mockResolvedValue({ id: undefined, output: undefined })
            }
        };
        const cap = new OpenAIImageEditCapabilityImpl(makeProvider(), client as any);
        const res = await cap.editImage(
            { input: { prompt: "edit", referenceImages: [{ role: "subject", base64: "SU1H", mimeType: "image/png" }] } } as any,
            new MultiModalExecutionContext()
        );

        expect(res.id).toBeDefined();
        expect(res.output).toEqual([]);
    });

    it("editImage uses default model/options metadata path", async () => {
        const provider = {
            ensureInitialized: vi.fn(),
            getMergedOptions: vi.fn(() => ({ model: undefined, modelParams: undefined, providerParams: undefined }))
        } as any;
        const client = {
            responses: {
                create: vi.fn().mockResolvedValue({ id: "r1", output: [] })
            }
        };
        const cap = new OpenAIImageEditCapabilityImpl(provider, client as any);
        const res = await cap.editImage(
            { input: { prompt: "edit", referenceImages: [{ role: "subject", base64: "SU1H", mimeType: "image/png" }] } } as any,
            new MultiModalExecutionContext()
        );

        const call = client.responses.create.mock.calls[0][0];
        expect(call.model).toBe("gpt-4.1");
        expect(res.metadata?.model).toBe("gpt-4.1");
    });

    it("editImageStream returns error chunk with stringified non-Error values", async () => {
        const client = {
            responses: {
                stream: vi.fn().mockImplementation(() => {
                    throw "boom";
                })
            }
        };
        const cap = new OpenAIImageEditCapabilityImpl(makeProvider(), client as any);
        const out = await cap.editImageStream(
            { input: { prompt: "edit", referenceImages: [{ role: "subject", base64: "SU1H", mimeType: "image/png" }] } } as any,
            new MultiModalExecutionContext()
        ).next();

        expect(out.value?.metadata?.status).toBe("error");
        expect(out.value?.error).toBe("boom");
    });

    it("editImageStream emits two image chunks and then completion when two completed events arrive", async () => {
        const stream = {
            async *[Symbol.asyncIterator]() {
                yield { type: "response.created", response: { id: "sid" } };
                yield { type: "response.completed", response: { output: [{ type: "image_generation_call", id: "a", result: "QQ==" }] } };
                yield { type: "response.completed", response: { output: [{ type: "image_generation_call", id: "b", result: "Qg==" }] } };
            }
        };
        const provider = {
            ensureInitialized: vi.fn(),
            getMergedOptions: vi.fn(() => ({ model: undefined, modelParams: undefined, providerParams: undefined }))
        } as any;
        const client = { responses: { stream: vi.fn().mockReturnValue(stream) } };
        const cap = new OpenAIImageEditCapabilityImpl(provider, client as any);
        const chunks: any[] = [];

        for await (const c of cap.editImageStream(
            { input: { prompt: "edit", referenceImages: [{ role: "subject", base64: "SU1H", mimeType: "image/png" }] } } as any,
            new MultiModalExecutionContext()
        )) {
            chunks.push(c);
        }

        expect(chunks).toHaveLength(3);
        expect(chunks[0].multimodalArtifacts?.masks).toBeDefined();
        expect(chunks[1].multimodalArtifacts?.masks).toBeUndefined();
        expect(chunks[2].metadata.model).toBe("gpt-4.1");
    });

    it("editImageStream returns silently when aborted during stream iteration", async () => {
        const controller = new AbortController();
        const stream = {
            async *[Symbol.asyncIterator]() {
                controller.abort();
                yield { type: "response.created", response: { id: "sid" } };
            }
        };
        const client = { responses: { stream: vi.fn().mockReturnValue(stream) } };
        const cap = new OpenAIImageEditCapabilityImpl(makeProvider(), client as any);
        const out = await cap.editImageStream(
            { input: { prompt: "edit", referenceImages: [{ role: "subject", base64: "SU1H", mimeType: "image/png" }] } } as any,
            new MultiModalExecutionContext(),
            controller.signal
        ).next();
        expect(out.done).toBe(true);
        expect(out.value).toBeUndefined();
    });

    it("editImageStream yields image chunk(s), completion, and error chunk", async () => {
        const okStream = {
            async *[Symbol.asyncIterator]() {
                yield { type: "response.created", response: { id: "sid" } };
                yield {
                    type: "response.completed",
                    response: { output: [{ type: "image_generation_call", id: "x", result: "QUJD" }] }
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

        const cap = new OpenAIImageEditCapabilityImpl(makeProvider(), client as any);
        const ctx = new MultiModalExecutionContext();
        const req = {
            input: {
                prompt: "edit",
                referenceImages: [{ role: "subject", base64: "SU1H", mimeType: "image/png" }]
            }
        } as any;

        const out: any[] = [];
        for await (const c of cap.editImageStream(req, ctx)) {
            out.push(c);
        }
        expect(out).toHaveLength(2);
        expect(out[0].metadata.status).toBe("incomplete");
        expect(out[0].output[0].base64).toBe("QUJD");
        expect(out[1].done).toBe(true);

        const err = await cap.editImageStream(req, ctx).next();
        expect(err.value?.metadata?.status).toBe("error");
    });

    it("editImageStream skips non-image output and can return silently when aborted", async () => {
        const silentStream = {
            async *[Symbol.asyncIterator]() {
                yield { type: "response.completed", response: { output: [{ type: "other" }] } };
            }
        };
        const client = {
            responses: {
                stream: vi.fn().mockReturnValue(silentStream)
            }
        };

        const cap = new OpenAIImageEditCapabilityImpl(makeProvider(), client as any);
        const req = {
            input: { prompt: "edit", referenceImages: [{ role: "subject", base64: "SU1H", mimeType: "image/png" }] }
        } as any;

        const chunks: any[] = [];
        for await (const c of cap.editImageStream(req, new MultiModalExecutionContext())) {
            chunks.push(c);
        }
        expect(chunks).toHaveLength(1);
        expect(chunks[0].done).toBe(true);

        const abortingClient = {
            responses: {
                stream: vi.fn().mockImplementation(() => {
                    throw new Error("stream fail");
                })
            }
        };
        const abortingCap = new OpenAIImageEditCapabilityImpl(makeProvider(), abortingClient as any);
        const controller = new AbortController();
        controller.abort();
        const out = await abortingCap.editImageStream(req, new MultiModalExecutionContext(), controller.signal).next();
        expect(out.done).toBe(true);
        expect(out.value).toBeUndefined();
    });

    it("prepareEditContent falls back to timeline subject image", () => {
        const cap = new OpenAIImageEditCapabilityImpl(makeProvider(), { responses: {} } as any) as any;
        const ctx = new MultiModalExecutionContext();
        ctx.attachArtifacts({ images: [{ id: "t1", base64: "SU1H", mimeType: "image/png" }] as any });

        const built = cap.prepareEditContent({ prompt: "edit", referenceImages: [] }, ctx);
        expect(built.content[0].type).toBe("input_image");
        expect(built.content[built.content.length - 1].text).toBe("edit");
    });

    it("prepareEditContent skips empty extra refs and helper ignores non-image outputs", () => {
        const cap = new OpenAIImageEditCapabilityImpl(makeProvider(), { responses: {} } as any) as any;
        const ctx = new MultiModalExecutionContext();

        const built = cap.prepareEditContent(
            {
                prompt: "edit",
                referenceImages: [
                    { role: "subject", base64: "SU1H", mimeType: "image/png" },
                    { role: "reference" }
                ]
            },
            ctx
        );
        expect(built.content.some((c: any) => c.type === "input_image" && !c.image_url)).toBe(false);
        expect(cap.normalizeEditedImages({ type: "other" }, 0)).toEqual([]);
    });

    it("normalizeEditedMasks only keeps string targetImageId and preserves mask kind", () => {
        const cap = new OpenAIImageEditCapabilityImpl(makeProvider(), { responses: {} } as any) as any;
        const masks = cap.normalizeEditedMasks([
            { id: "m1", base64: "QQ==", mimeType: "image/png", extras: { targetImageId: 123, kind: "binary" } },
            { id: "m2", base64: "QQ==", mimeType: "image/png", extras: { targetImageId: "img-2", kind: "alpha" } }
        ]);
        expect(masks[0].targetImageId).toBeUndefined();
        expect(masks[0].kind).toBe("binary");
        expect(masks[1].targetImageId).toBe("img-2");
    });

    it("prepareEditContent includes valid extra reference image URLs", () => {
        const cap = new OpenAIImageEditCapabilityImpl(makeProvider(), { responses: {} } as any) as any;
        const built = cap.prepareEditContent(
            {
                prompt: "edit",
                referenceImages: [
                    { role: "subject", base64: "SU1H", mimeType: "image/png" },
                    { role: "reference", url: "https://example.com/ref.png", mimeType: "image/png" }
                ]
            },
            new MultiModalExecutionContext()
        );
        expect(built.content.some((c: any) => c.type === "input_image" && String(c.image_url).includes("https://example.com/ref.png"))).toBe(true);
    });
});
