import { describe, expect, it, vi } from "vitest";
import { GeminiImageGenerationCapabilityImpl } from "#root/providers/gemini/capabilities/GeminiImageGenerationCapabilityImpl.js";

function makeProvider() {
    return {
        ensureInitialized: vi.fn(),
        getMergedOptions: vi.fn(() => ({ model: "imagen-4.0-generate-001", modelParams: {}, providerParams: {} }))
    } as any;
}

describe("GeminiImageGenerationCapabilityImpl", () => {
    it("validates missing prompt in non-stream and stream", async () => {
        const cap = new GeminiImageGenerationCapabilityImpl(makeProvider(), { models: {} } as any);

        await expect(cap.generateImage({ input: {} } as any)).rejects.toThrow("Prompt is required for image generation");
        await expect(cap.generateImageStream({ input: {} } as any).next()).rejects.toThrow("Prompt is required for image generation");
    });

    it("generateImage normalizes generated images", async () => {
        const client = {
            models: {
                generateImages: vi.fn().mockResolvedValue({
                    generatedImages: [
                        { image: { imageBytes: "QUJD", mimeType: "image/png" } },
                        { image: { bytesBase64Encoded: "REVG", mimeType: "image/jpeg" } }
                    ]
                })
            }
        };

        const cap = new GeminiImageGenerationCapabilityImpl(makeProvider(), client as any);
        const res = await cap.generateImage({ input: { prompt: "draw cat" }, context: { requestId: "rid" } } as any);

        expect(res.output).toHaveLength(2);
        expect(res.output[0].base64).toBe("QUJD");
        expect(res.output[0].url).toContain("data:image/png;base64,QUJD");
        expect(res.output[1].mimeType).toBe("image/jpeg");
        expect(res.metadata?.provider).toBe("gemini");
        expect(res.metadata?.requestId).toBe("rid");
    });

    it("generateImage supports reference images and style role mapping", async () => {
        const client = {
            models: {
                generateImages: vi.fn().mockResolvedValue({
                    generatedImages: [{ image: { imageBytes: "QUJD", mimeType: "image/png" } }]
                })
            }
        };

        const cap = new GeminiImageGenerationCapabilityImpl(makeProvider(), client as any);
        await cap.generateImage({
            input: {
                prompt: "draw cat",
                referenceImages: [{ role: "style", base64: "data:image/png;base64,QUJD", mimeType: "image/png", weight: 0.2 }]
            }
        } as any);

        const call = client.models.generateImages.mock.calls[0][0];
        expect(call.referenceImages).toHaveLength(1);
        expect(call.referenceImages[0].referenceId).toBe(1);
        expect(call.referenceImages[0].referenceType).toBe("REFERENCE_TYPE_STYLE");
    });

    it("generateImage uses default model/options and subject role mapping", async () => {
        const provider = {
            ensureInitialized: vi.fn(),
            getMergedOptions: vi.fn(() => ({ model: undefined, modelParams: undefined, providerParams: undefined }))
        } as any;
        const client = {
            models: {
                generateImages: vi.fn().mockResolvedValue({ generatedImages: [] })
            }
        };
        const cap = new GeminiImageGenerationCapabilityImpl(provider, client as any);
        await cap.generateImage({
            input: {
                prompt: "draw",
                referenceImages: [{ role: "subject", base64: "data:image/png;base64,QUJD", mimeType: "image/png", weight: 1 }]
            }
        } as any);

        const call = client.models.generateImages.mock.calls[0][0];
        expect(call.model).toBe("imagen-4.0-generate-001");
        expect(call.referenceImages[0].referenceType).toBe("REFERENCE_TYPE_SUBJECT");
        expect(call.config.referenceImageWeight).toBe("HIGH");
    });

    it("generateImage supports binary image bytes and size mapping passthrough", async () => {
        const client = {
            models: {
                generateImages: vi.fn().mockResolvedValue({
                    generatedImages: [{ image: { imageBytes: Uint8Array.from([65, 66]), mimeType: "image/png" } }]
                })
            }
        };
        const cap = new GeminiImageGenerationCapabilityImpl(makeProvider(), client as any);
        const res = await cap.generateImage({ input: { prompt: "draw", params: { size: "9:16" } } } as any);

        expect(res.output[0].base64).toBe(Buffer.from([65, 66]).toString("base64"));
        expect(client.models.generateImages.mock.calls[0][0].config.aspectRatio).toBe("9:16");
    });

    it("generateImage uses default mimeType when reference/generated image mime is missing", async () => {
        const client = {
            models: {
                generateImages: vi.fn().mockResolvedValue({
                    generatedImages: [{ image: { imageBytes: "QUJD" } }]
                })
            }
        };
        const cap = new GeminiImageGenerationCapabilityImpl(makeProvider(), client as any);
        const res = await cap.generateImage({
            input: { prompt: "draw", referenceImages: [{ role: "subject", base64: "data:image/png;base64,QUJD" }] }
        } as any);

        const call = client.models.generateImages.mock.calls[0][0];
        expect(call.referenceImages[0].referenceImage.mimeType).toBe("image/png");
        expect(res.output[0].mimeType).toBe("image/png");
    });

    it("generateImageStream emits final completed chunk and error chunk", async () => {
        const provider = makeProvider();
        const client = {
            models: {
                generateImages: vi
                    .fn()
                    .mockResolvedValueOnce({ generatedImages: [{ image: { imageBytes: "QUJD", mimeType: "image/png" } }] })
                    .mockRejectedValueOnce(new Error("generation fail"))
            }
        };

        const cap = new GeminiImageGenerationCapabilityImpl(provider, client as any);

        const first = await cap.generateImageStream({ input: { prompt: "draw" }, context: { requestId: "r1" } } as any).next();
        expect(first.value?.done).toBe(true);
        expect(first.value?.metadata?.status).toBe("completed");
        expect(first.value?.output).toHaveLength(1);

        const second = await cap.generateImageStream({ input: { prompt: "draw" } } as any).next();
        expect(second.value?.done).toBe(true);
        expect(second.value?.metadata?.status).toBe("error");
    });

    it("generateImage and stream exit silently when aborted around API call", async () => {
        const controllerA = new AbortController();
        const clientA = {
            models: {
                generateImages: vi.fn().mockImplementation(async () => {
                    controllerA.abort();
                    return { generatedImages: [] };
                })
            }
        };
        const capA = new GeminiImageGenerationCapabilityImpl(makeProvider(), clientA as any);

        await expect(capA.generateImage({ input: { prompt: "draw" } } as any, undefined, controllerA.signal)).rejects.toThrow(
            "aborted after API call"
        );

        const controllerB = new AbortController();
        const clientB = {
            models: {
                generateImages: vi.fn().mockImplementation(async () => {
                    controllerB.abort();
                    throw new Error("aborted");
                })
            }
        };
        const capB = new GeminiImageGenerationCapabilityImpl(makeProvider(), clientB as any);
        const out = await capB.generateImageStream({ input: { prompt: "draw" } } as any, undefined, controllerB.signal).next();
        expect(out.done).toBe(true);
        expect(out.value).toBeUndefined();
    });

    it("generateImage throws when already aborted before API call", async () => {
        const controller = new AbortController();
        controller.abort();
        const client = {
            models: {
                generateImages: vi.fn()
            }
        };
        const cap = new GeminiImageGenerationCapabilityImpl(makeProvider(), client as any);

        await expect(cap.generateImage({ input: { prompt: "draw" } } as any, undefined, controller.signal)).rejects.toThrow(
            "aborted before API call"
        );
        expect(client.models.generateImages).not.toHaveBeenCalled();
    });

    it("generateImageStream handles reference images and abort after API call", async () => {
        const controller = new AbortController();
        const client = {
            models: {
                generateImages: vi.fn().mockImplementation(async () => {
                    controller.abort();
                    return { generatedImages: [{ image: { bytesBase64Encoded: "QUJD", mimeType: "image/png" } }] };
                })
            }
        };
        const cap = new GeminiImageGenerationCapabilityImpl(makeProvider(), client as any);

        const out = await cap.generateImageStream(
            {
                input: {
                    prompt: "draw",
                    referenceImages: [{ role: "subject", base64: "data:image/png;base64,QUJD", mimeType: "image/png" }]
                }
            } as any,
            undefined,
            controller.signal
        ).next();

        expect(out.done).toBe(true);
        expect(out.value).toBeUndefined();
    });

    it("generateImageStream uses default model/mime and emits error for non-Error throw", async () => {
        const provider = {
            ensureInitialized: vi.fn(),
            getMergedOptions: vi.fn(() => ({ model: undefined, modelParams: undefined, providerParams: undefined }))
        } as any;

        const okClient = {
            models: {
                generateImages: vi.fn().mockResolvedValue({
                    generatedImages: [{ image: { imageBytes: "QUJD" } }]
                })
            }
        };
        const okCap = new GeminiImageGenerationCapabilityImpl(provider, okClient as any);
        const ok = await okCap.generateImageStream({ input: { prompt: "draw" } } as any).next();
        expect(ok.value?.done).toBe(true);
        expect(ok.value?.metadata?.model).toBe("imagen-4.0-generate-001");
        expect(ok.value?.output[0].mimeType).toBe("image/png");

        const badClient = {
            models: {
                generateImages: vi.fn().mockImplementation(() => {
                    throw "bad";
                })
            }
        };
        const badCap = new GeminiImageGenerationCapabilityImpl(provider, badClient as any);
        const bad = await badCap.generateImageStream({ input: { prompt: "draw" } } as any).next();
        expect(bad.value?.metadata?.status).toBe("error");
        expect(bad.value?.metadata?.error).toBe("bad");
    });

    it("generateImageStream exits early when signal is aborted before API call", async () => {
        const controller = new AbortController();
        controller.abort();
        const client = {
            models: {
                generateImages: vi.fn()
            }
        };
        const cap = new GeminiImageGenerationCapabilityImpl(makeProvider(), client as any);
        const out = await cap.generateImageStream({ input: { prompt: "draw" } } as any, undefined, controller.signal).next();
        expect(out.done).toBe(true);
        expect(out.value).toBeUndefined();
    });

    it("helper mapping methods cover ratio/weight/tag branches", () => {
        const cap = new GeminiImageGenerationCapabilityImpl(makeProvider(), { models: {} } as any) as any;

        expect(cap.mapSizeToImagenAspectRatio(undefined)).toBe("1:1");
        expect(cap.mapSizeToImagenAspectRatio("4:3")).toBe("4:3");
        expect(cap.mapSizeToImagenAspectRatio("bad")).toBe("1:1");
        expect(cap.mapSizeToImagenAspectRatio("0x10")).toBe("1:1");
        expect(cap.mapSizeToImagenAspectRatio("1536x1024")).toBe("4:3");

        expect(cap.mapWeight(undefined)).toBe("HIGH");
        expect(cap.mapWeight(0.2)).toBe("LOW");
        expect(cap.mapWeight(0.5)).toBe("MEDIUM");

        expect(cap.injectReferenceTags("draw portrait", 2)).toContain("[1]");
        expect(cap.injectReferenceTags("draw [1] portrait", 1)).toContain("[1]");
    });
});
