import { describe, expect, it, vi } from "vitest";
import { MultiModalExecutionContext } from "#root/index.js";
import { GeminiOCRCapabilityImpl } from "#root/providers/gemini/capabilities/GeminiOCRCapabilityImpl.js";

function makeProvider() {
    return {
        ensureInitialized: vi.fn(),
        getMergedOptions: vi.fn(() => ({
            model: "gemini-2.5-pro",
            modelParams: {},
            providerParams: {},
            generalParams: {}
        }))
    } as any;
}

describe("GeminiOCRCapabilityImpl", () => {
    it("extracts OCR text from Gemini JSON output", async () => {
        const client = {
            models: {
                generateContent: vi.fn().mockResolvedValue({
                    responseId: "gem-ocr-1",
                    text: JSON.stringify({
                        fullText: "Cloud Computing Essentials",
                        pages: [{ pageNumber: 1, fullText: "Cloud Computing Essentials" }],
                        headers: [{ pageNumber: 1, text: "ASSIGNMENT" }],
                        footers: [{ pageNumber: 1, text: "at skillbuilder.aws" }]
                    })
                })
            }
        } as any;

        const cap = new GeminiOCRCapabilityImpl(makeProvider(), client);
        const response = await cap.ocr(
            {
                input: {
                    file: "https://example.com/doc.png",
                    mimeType: "image/png",
                    language: "en"
                },
                context: { requestId: "ocr-g-1" }
            } as any,
            new MultiModalExecutionContext()
        );

        expect(response.output[0]?.fullText).toContain("Cloud Computing Essentials");
        expect(response.output[0]?.pages?.[0]?.pageNumber).toBe(1);
        expect(response.output[0]?.headers?.[0]?.text).toBe("ASSIGNMENT");
        expect(response.output[0]?.footers?.[0]?.text).toBe("at skillbuilder.aws");
        expect(response.metadata?.provider).toBe("gemini");
    });

    it("includes structured annotations when Gemini returns them", async () => {
        const client = {
            models: {
                generateContent: vi.fn().mockResolvedValue({
                    responseId: "gem-ocr-2",
                    text: JSON.stringify({
                        fullText: "Cloud Computing Essentials",
                        annotations: [
                            {
                                type: "document",
                                text: "{\"mainTitle\":\"Cloud Computing Essentials\"}",
                                data: { mainTitle: "Cloud Computing Essentials" }
                            }
                        ]
                    })
                })
            }
        } as any;

        const cap = new GeminiOCRCapabilityImpl(makeProvider(), client);
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

        expect(response.output[0]?.annotations?.[0]?.type).toBe("document");
        expect(response.output[0]?.annotations?.[0]?.data).toEqual({ mainTitle: "Cloud Computing Essentials" });
    });

    it("falls back to raw text when Gemini does not return valid JSON", async () => {
        const client = {
            models: {
                generateContent: vi.fn().mockResolvedValue({
                    responseId: "gem-ocr-3",
                    text: "Plain OCR output without JSON"
                })
            }
        } as any;

        const cap = new GeminiOCRCapabilityImpl(makeProvider(), client);
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

    it("replaces prompt-echo annotation text with structured data JSON when available", async () => {
        const client = {
            models: {
                generateContent: vi.fn().mockResolvedValue({
                    responseId: "gem-ocr-4",
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
                })
            }
        } as any;

        const cap = new GeminiOCRCapabilityImpl(makeProvider(), client);
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

        expect(response.output[0]?.annotations?.[0]?.text).toBe('{"mainTitle":"Cloud Computing Essentials"}');
        expect(response.output[0]?.annotations?.[0]?.data).toEqual({ mainTitle: "Cloud Computing Essentials" });
    });

    it("uses inline PDF content for local PDF OCR files", async () => {
        const client = {
            models: {
                generateContent: vi.fn().mockResolvedValue({
                    responseId: "gem-ocr-pdf-1",
                    text: "{}"
                })
            }
        } as any;

        const cap = new GeminiOCRCapabilityImpl(makeProvider(), client);
        await cap.ocr(
            {
                input: {
                    file: Buffer.from("%PDF-1.7 fake pdf bytes"),
                    filename: "doc.pdf",
                    mimeType: "application/pdf"
                }
            } as any,
            new MultiModalExecutionContext()
        );

        const payload = client.models.generateContent.mock.calls[0][0];
        const pdfPart = payload.contents[0].parts.find((part: any) => part.inlineData);
        expect(pdfPart).toBeDefined();
        expect(pdfPart.inlineData.mimeType).toBe("application/pdf");
        expect(typeof pdfPart.inlineData.data).toBe("string");
        expect(payload.contents[0].parts.some((part: any) => part.fileData)).toBe(false);
    });
});
