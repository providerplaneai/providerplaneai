import { describe, expect, it, vi } from "vitest";
import { MultiModalExecutionContext } from "#root/index.js";
import { AnthropicOCRCapabilityImpl } from "#root/providers/anthropic/capabilities/AnthropicOCRCapabilityImpl.js";

function makeProvider() {
    return {
        ensureInitialized: vi.fn(),
        getMergedOptions: vi.fn(() => ({
            model: "claude-sonnet-4-5-20250929",
            modelParams: {},
            providerParams: {},
            generalParams: {}
        }))
    } as any;
}

describe("AnthropicOCRCapabilityImpl", () => {
    it("extracts OCR text from Anthropic JSON output", async () => {
        const client = {
            messages: {
                create: vi.fn().mockResolvedValue({
                    id: "anthropic-ocr-1",
                    content: [
                        {
                            type: "text",
                            text: JSON.stringify({
                                fullText: "Cloud Computing Essentials",
                                pages: [{ pageNumber: 1, fullText: "Cloud Computing Essentials" }],
                                headers: [{ pageNumber: 1, text: "ASSIGNMENT" }],
                                footers: [{ pageNumber: 1, text: "at skillbuilder.aws" }]
                            })
                        }
                    ]
                })
            }
        } as any;

        const cap = new AnthropicOCRCapabilityImpl(makeProvider(), client);
        const response = await cap.ocr(
            {
                input: {
                    file: "https://example.com/doc.png",
                    mimeType: "image/png",
                    language: "en"
                },
                context: { requestId: "ocr-a-1" }
            } as any,
            new MultiModalExecutionContext()
        );

        expect(response.output[0]?.fullText).toContain("Cloud Computing Essentials");
        expect(response.output[0]?.pages?.[0]?.pageNumber).toBe(1);
        expect(response.output[0]?.headers?.[0]?.text).toBe("ASSIGNMENT");
        expect(response.output[0]?.footers?.[0]?.text).toBe("at skillbuilder.aws");
        expect(response.metadata?.provider).toBe("anthropic");
    });

    it("includes structured annotations and cleans prompt-echo text", async () => {
        const client = {
            messages: {
                create: vi.fn().mockResolvedValue({
                    id: "anthropic-ocr-2",
                    content: [
                        {
                            type: "text",
                            text: JSON.stringify({
                                fullText: "Cloud Computing Essentials",
                                annotations: [
                                    {
                                        type: "document",
                                        text: "Extract the main title.",
                                        data: { mainTitle: "Cloud Computing Essentials" }
                                    }
                                ]
                            })
                        }
                    ]
                })
            }
        } as any;

        const cap = new AnthropicOCRCapabilityImpl(makeProvider(), client);
        const response = await cap.ocr(
            {
                input: {
                    file: "https://example.com/doc.png",
                    mimeType: "image/png",
                    structured: {
                        annotationMode: "document",
                        annotationPrompt: "Extract the main title.",
                        annotationSchema: {
                            name: "title_only",
                            schema: {
                                type: "object",
                                properties: {
                                    mainTitle: { type: "string" }
                                }
                            }
                        }
                    }
                }
            } as any,
            new MultiModalExecutionContext()
        );

        expect(response.output[0]?.annotations?.[0]?.data).toEqual({ mainTitle: "Cloud Computing Essentials" });
        expect(response.output[0]?.annotations?.[0]?.text).toBe('{"mainTitle":"Cloud Computing Essentials"}');
    });

    it("falls back to raw text when Anthropic does not return valid JSON", async () => {
        const client = {
            messages: {
                create: vi.fn().mockResolvedValue({
                    id: "anthropic-ocr-3",
                    content: [{ type: "text", text: "Plain OCR output without JSON" }]
                })
            }
        } as any;

        const cap = new AnthropicOCRCapabilityImpl(makeProvider(), client);
        const response = await cap.ocr(
            {
                input: {
                    file: "https://example.com/doc.pdf",
                    mimeType: "application/pdf"
                }
            } as any,
            new MultiModalExecutionContext()
        );

        expect(response.output[0]?.fullText).toBe("Plain OCR output without JSON");
        expect(response.output[0]?.text?.[0]?.text).toBe("Plain OCR output without JSON");
    });

    it("uses image blocks for image OCR and document blocks for PDFs", async () => {
        const client = {
            messages: {
                create: vi.fn().mockResolvedValue({
                    id: "anthropic-ocr-4",
                    content: [{ type: "text", text: "{}" }]
                })
            }
        } as any;

        const cap = new AnthropicOCRCapabilityImpl(makeProvider(), client);
        await cap.ocr(
            {
                input: {
                    file: Buffer.from("fake-image"),
                    mimeType: "image/png"
                }
            } as any,
            new MultiModalExecutionContext()
        );

        const imagePayload = client.messages.create.mock.calls[0][0];
        expect(imagePayload.messages[0].content.some((part: any) => part.type === "image")).toBe(true);
        expect(imagePayload.messages[0].content.some((part: any) => part.type === "document")).toBe(false);

        await cap.ocr(
            {
                input: {
                    file: Buffer.from("fake-pdf"),
                    mimeType: "application/pdf"
                }
            } as any,
            new MultiModalExecutionContext()
        );

        const pdfPayload = client.messages.create.mock.calls[1][0];
        expect(pdfPayload.messages[0].content.some((part: any) => part.type === "document")).toBe(true);
    });
});
