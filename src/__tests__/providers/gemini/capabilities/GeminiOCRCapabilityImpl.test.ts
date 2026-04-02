import { describe, expect, it, vi } from "vitest";
import { MultiModalExecutionContext } from "#root/index.js";
import { GeminiOCRCapabilityImpl } from "#root/providers/gemini/capabilities/GeminiOCRCapabilityImpl.js";
import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

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

    it("uses fileData for remote image OCR inputs and remote file OCR inputs", async () => {
        const client = {
            models: {
                generateContent: vi.fn().mockResolvedValue({
                    responseId: "gem-ocr-5",
                    text: "{}"
                })
            }
        } as any;

        const cap = new GeminiOCRCapabilityImpl(makeProvider(), client);

        await cap.ocr(
            {
                input: {
                    images: [{ id: "img-1", sourceType: "url", url: "https://example.com/scan.png" }]
                }
            } as any,
            new MultiModalExecutionContext()
        );

        await cap.ocr(
            {
                input: {
                    file: "https://example.com/archive.pdf",
                    mimeType: "application/pdf"
                }
            } as any,
            new MultiModalExecutionContext()
        );

        const imagePayload = client.models.generateContent.mock.calls[0][0];
        expect(imagePayload.contents[0].parts.some((part: any) => part.fileData?.fileUri === "https://example.com/scan.png")).toBe(
            true
        );

        const filePayload = client.models.generateContent.mock.calls[1][0];
        expect(filePayload.contents[0].parts.some((part: any) => part.fileData?.fileUri === "https://example.com/archive.pdf")).toBe(
            true
        );
    });

    it("extracts fallback text from candidate parts when response.text is absent", async () => {
        const client = {
            models: {
                generateContent: vi.fn().mockResolvedValue({
                    responseId: "gem-ocr-6",
                    candidates: [
                        {
                            content: {
                                parts: [{ text: "Part A" }, { text: "Part B" }]
                            }
                        }
                    ]
                })
            }
        } as any;

        const cap = new GeminiOCRCapabilityImpl(makeProvider(), client);
        const response = await cap.ocr(
            {
                input: {
                    file: Buffer.from("plain text"),
                    filename: "fixture.txt",
                    mimeType: "text/plain"
                }
            } as any,
            new MultiModalExecutionContext()
        );

        expect(response.output[0]?.fullText).toBe("Part A\nPart B");
    });

    it("rejects unsupported OCR input types", async () => {
        const client = {
            models: {
                generateContent: vi.fn()
            }
        } as any;

        const cap = new GeminiOCRCapabilityImpl(makeProvider(), client);
        await expect(
            cap.ocr(
                {
                    input: {
                        file: 123 as any,
                        mimeType: "application/octet-stream"
                    }
                } as any,
                new MultiModalExecutionContext()
            )
        ).rejects.toThrow("Unsupported input source");
    });

    it("uses inlineData for base64 image inputs", async () => {
        const client = {
            models: {
                generateContent: vi.fn().mockResolvedValue({
                    responseId: "gem-ocr-7",
                    text: "{}"
                })
            }
        } as any;

        const cap = new GeminiOCRCapabilityImpl(makeProvider(), client);
        await cap.ocr(
            {
                input: {
                    images: [{ id: "img-1", sourceType: "base64", base64: "QUJD", mimeType: "image/png" }]
                }
            } as any,
            new MultiModalExecutionContext()
        );

        const payload = client.models.generateContent.mock.calls[0][0];
        expect(payload.contents[0].parts.some((part: any) => part.inlineData?.data === "QUJD")).toBe(true);
    });

    it("returns empty fallback text when Gemini candidates are missing usable parts", async () => {
        const client = {
            models: {
                generateContent: vi.fn().mockResolvedValue({
                    responseId: "gem-ocr-8",
                    candidates: [{ content: {} }, { content: { parts: [{ inlineData: { data: "AQID" } }] } }]
                })
            }
        } as any;

        const cap = new GeminiOCRCapabilityImpl(makeProvider(), client);
        const response = await cap.ocr(
            {
                input: {
                    file: Buffer.from("plain text"),
                    filename: "fixture.txt",
                    mimeType: "text/plain"
                }
            } as any,
            new MultiModalExecutionContext()
        );

        expect(response.output[0]?.fullText).toBeUndefined();
        expect(response.output[0]?.text).toBeUndefined();
    });

    it("infers mime type from local file paths when mimeType is omitted", async () => {
        const client = {
            models: {
                generateContent: vi.fn().mockResolvedValue({
                    responseId: "gem-ocr-9",
                    text: "{}"
                })
            }
        } as any;

        const dir = await mkdtemp(join(tmpdir(), "gemini-ocr-"));
        const textPath = join(dir, "fixture.txt");
        await writeFile(textPath, "hello");

        const cap = new GeminiOCRCapabilityImpl(makeProvider(), client);
        await cap.ocr(
            {
                input: {
                    file: textPath
                }
            } as any,
            new MultiModalExecutionContext()
        );

        const payload = client.models.generateContent.mock.calls[0][0];
        const inlinePart = payload.contents[0].parts.find((part: any) => part.inlineData);
        expect(inlinePart.inlineData.mimeType).toBe("text/plain");
    });

    it("includes structured prompt instructions and request-id fallback when responseId is omitted", async () => {
        const client = {
            models: {
                generateContent: vi.fn().mockResolvedValue({
                    text: "{}"
                })
            }
        } as any;

        const cap = new GeminiOCRCapabilityImpl(makeProvider(), client);
        const response = await cap.ocr(
            {
                input: {
                    images: [{ id: "img-1", sourceType: "url", url: "https://example.com/scan.webp" }],
                    language: "fr",
                    prompt: "Preserve handwritten notes.",
                    structured: {
                        annotationMode: "document",
                        annotationPrompt: "Extract invoice fields.",
                        annotationSchema: {
                            name: "invoice_schema",
                            schema: {
                                type: "object",
                                properties: {
                                    invoiceNumber: { type: "string" }
                                }
                            }
                        },
                        extractHeaders: true,
                        extractFooters: true,
                        tableFormat: "html"
                    }
                },
                context: { requestId: "gemini-ocr-fallback-id" }
            } as any,
            new MultiModalExecutionContext()
        );

        const promptText = client.models.generateContent.mock.calls[0][0].contents[0].parts[0].text as string;
        expect(promptText).toContain("Language hint: fr");
        expect(promptText).toContain("OCR guidance: Preserve handwritten notes.");
        expect(promptText).toContain("Structured extraction mode: document");
        expect(promptText).toContain("Structured extraction prompt: Extract invoice fields.");
        expect(promptText).toContain("Structured extraction schema name: invoice_schema");
        expect(promptText).toContain('"invoiceNumber"');
        expect(promptText).toContain("Extract document/page headers when visible.");
        expect(promptText).toContain("Extract document/page footers when visible.");
        expect(promptText).toContain("Represent tables using html when present.");
        expect(response.id).toBe("gemini-ocr-fallback-id");
    });

    it("normalizes page/header/footer fallback fields and returns empty text when candidates are not an array", async () => {
        const client = {
            models: {
                generateContent: vi.fn()
                    .mockResolvedValueOnce({
                        responseId: "gem-ocr-10",
                        text: JSON.stringify({
                            pages: [
                                { fullText: "Page one body" },
                                { pageNumber: 2, fullText: "" }
                            ],
                            annotations: [
                                { type: "bbox", label: "total", text: "42.00", pageNumber: 1 },
                                { type: "document", data: { vendor: "ACME" } },
                                null
                            ],
                            headers: [{ text: "Header fallback" }],
                            footers: [{ text: "Footer fallback" }]
                        })
                    })
                    .mockResolvedValueOnce({
                        responseId: "gem-ocr-11",
                        candidates: {}
                    })
            }
        } as any;

        const cap = new GeminiOCRCapabilityImpl(makeProvider(), client);

        const normalized = await cap.ocr(
            {
                input: {
                    file: "https://example.com/doc.pdf",
                    mimeType: "application/pdf"
                }
            } as any,
            new MultiModalExecutionContext()
        );

        expect(normalized.output[0]?.fullText).toBe("Page one body");
        expect(normalized.output[0]?.pages).toEqual([{ pageNumber: 1, fullText: "Page one body", text: [{ text: "Page one body" }] }]);
        expect(normalized.output[0]?.annotations).toEqual([
            { type: "bbox", label: "total", text: "42.00", pageNumber: 1 },
            { type: "document", data: { vendor: "ACME" } }
        ]);
        expect(normalized.output[0]?.headers).toEqual([{ pageNumber: 1, text: "Header fallback" }]);
        expect(normalized.output[0]?.footers).toEqual([{ pageNumber: 1, text: "Footer fallback" }]);

        const empty = await cap.ocr(
            {
                input: {
                    file: Buffer.from("plain text"),
                    filename: "fixture.txt",
                    mimeType: "text/plain"
                }
            } as any,
            new MultiModalExecutionContext()
        );

        expect(empty.output[0]?.fullText).toBeUndefined();
        expect(empty.output[0]?.text).toBeUndefined();
    });
});
