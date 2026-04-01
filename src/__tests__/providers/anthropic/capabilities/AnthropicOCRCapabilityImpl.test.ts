import { describe, expect, it, vi } from "vitest";
import { MultiModalExecutionContext } from "#root/index.js";
import { AnthropicOCRCapabilityImpl } from "#root/providers/anthropic/capabilities/AnthropicOCRCapabilityImpl.js";
import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

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
    it("rejects aborted requests before execution starts", async () => {
        const client = {
            messages: {
                create: vi.fn()
            }
        } as any;

        const controller = new AbortController();
        controller.abort();
        const cap = new AnthropicOCRCapabilityImpl(makeProvider(), client);

        await expect(
            cap.ocr(
                {
                    input: {
                        file: "https://example.com/doc.pdf",
                        mimeType: "application/pdf"
                    }
                } as any,
                new MultiModalExecutionContext(),
                controller.signal
            )
        ).rejects.toThrow("OCR request aborted before execution");

        expect(client.messages.create).not.toHaveBeenCalled();
    });

    it("rejects requests with no source or mixed file/images sources", async () => {
        const client = {
            messages: {
                create: vi.fn()
            }
        } as any;

        const cap = new AnthropicOCRCapabilityImpl(makeProvider(), client);

        await expect(cap.ocr({ input: {} } as any, new MultiModalExecutionContext())).rejects.toThrow(
            "OCR requires either `file` or one or more `images`"
        );

        await expect(
            cap.ocr(
                {
                    input: {
                        file: "https://example.com/doc.pdf",
                        images: [{ id: "img-1", sourceType: "url", url: "https://example.com/image.png" }]
                    }
                } as any,
                new MultiModalExecutionContext()
            )
        ).rejects.toThrow("Anthropic OCR accepts either `file` or `images`, not both");
    });

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

    it("uses URL-backed document parts for remote PDFs and URL-backed image parts for remote images", async () => {
        const client = {
            messages: {
                create: vi.fn().mockResolvedValue({
                    id: "anthropic-ocr-5",
                    content: [{ type: "text", text: "{}" }]
                })
            }
        } as any;

        const cap = new AnthropicOCRCapabilityImpl(makeProvider(), client);
        await cap.ocr(
            {
                input: {
                    file: "https://example.com/report.pdf",
                    mimeType: "application/pdf",
                    filename: "report.pdf"
                }
            } as any,
            new MultiModalExecutionContext()
        );

        await cap.ocr(
            {
                input: {
                    file: "https://example.com/screenshot.jpeg"
                }
            } as any,
            new MultiModalExecutionContext()
        );

        const pdfPayload = client.messages.create.mock.calls[0][0];
        expect(pdfPayload.messages[0].content[1]).toMatchObject({
            type: "document",
            title: "report.pdf",
            source: { type: "url", url: "https://example.com/report.pdf" }
        });

        const imagePayload = client.messages.create.mock.calls[1][0];
        expect(imagePayload.messages[0].content[1]).toMatchObject({
            type: "image",
            source: { type: "url", url: "https://example.com/screenshot.jpeg" }
        });
    });

    it("strips data URI prefixes from base64 document uploads and rejects unsupported mime types", async () => {
        const client = {
            messages: {
                create: vi.fn().mockResolvedValue({
                    id: "anthropic-ocr-6",
                    content: [{ type: "text", text: "{}" }]
                })
            }
        } as any;

        const cap = new AnthropicOCRCapabilityImpl(makeProvider(), client);
        await cap.ocr(
            {
                input: {
                    file: "data:application/pdf;base64,JVBERi0xLjc=",
                    filename: "inline.pdf"
                }
            } as any,
            new MultiModalExecutionContext()
        );

        const payload = client.messages.create.mock.calls[0][0];
        expect(payload.messages[0].content[1]).toMatchObject({
            type: "document",
            title: "inline.pdf",
            source: {
                type: "base64",
                media_type: "application/pdf",
                data: "JVBERi0xLjc="
            }
        });

        await expect(
            cap.ocr(
                {
                    input: {
                        file: Buffer.from("not supported"),
                        mimeType: "text/plain"
                    }
                } as any,
                new MultiModalExecutionContext()
            )
        ).rejects.toThrow("Anthropic OCR only supports image and PDF inputs");
    });

    it("concatenates multiple text blocks when extracting fallback content", async () => {
        const client = {
            messages: {
                create: vi.fn().mockResolvedValue({
                    id: "anthropic-ocr-7",
                    content: [
                        { type: "text", text: "Part A" },
                        { type: "text", text: "Part B" }
                    ]
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

        expect(response.output[0]?.fullText).toBe("Part APart B");
    });

    it("builds base64 image parts for inline image inputs and includes table format instructions", async () => {
        const client = {
            messages: {
                create: vi.fn().mockResolvedValue({
                    id: "anthropic-ocr-8",
                    content: [{ type: "text", text: "{}" }]
                })
            }
        } as any;

        const cap = new AnthropicOCRCapabilityImpl(makeProvider(), client);
        await cap.ocr(
            {
                input: {
                    file: "data:image/png;base64,QUJD",
                    structured: {
                        tableFormat: "markdown"
                    }
                }
            } as any,
            new MultiModalExecutionContext()
        );

        const payload = client.messages.create.mock.calls[0][0];
        expect(payload.messages[0].content[0].text).toContain("Represent tables using markdown when present.");
        expect(payload.messages[0].content[1]).toMatchObject({
            type: "image",
            source: {
                type: "base64",
                media_type: "image/png",
                data: "QUJD"
            }
        });
    });

    it("infers mime type from local path inputs when mimeType is omitted", async () => {
        const client = {
            messages: {
                create: vi.fn().mockResolvedValue({
                    id: "anthropic-ocr-9",
                    content: [{ type: "text", text: "{}" }]
                })
            }
        } as any;

        const dir = await mkdtemp(join(tmpdir(), "anthropic-ocr-"));
        const imagePath = join(dir, "local-image.png");
        await writeFile(imagePath, Buffer.from([1, 2, 3]));

        const cap = new AnthropicOCRCapabilityImpl(makeProvider(), client);
        await cap.ocr(
            {
                input: {
                    file: imagePath
                }
            } as any,
            new MultiModalExecutionContext()
        );

        const payload = client.messages.create.mock.calls[0][0];
        expect(payload.messages[0].content[1]).toMatchObject({
            type: "image",
            source: {
                type: "base64",
                media_type: "image/png",
                data: expect.any(String)
            }
        });
    });

    it("uses image reference inputs with base64 payloads and includes header/footer instructions", async () => {
        const client = {
            messages: {
                create: vi.fn().mockResolvedValue({
                    id: "anthropic-ocr-10",
                    content: [{ type: "text", text: "{}" }]
                })
            }
        } as any;

        const cap = new AnthropicOCRCapabilityImpl(makeProvider(), client);
        await cap.ocr(
            {
                input: {
                    images: [{ id: "img-1", sourceType: "base64", base64: "QUJD", mimeType: "image/png" }],
                    structured: {
                        extractHeaders: true,
                        extractFooters: true
                    }
                }
            } as any,
            new MultiModalExecutionContext()
        );

        const payload = client.messages.create.mock.calls[0][0];
        const promptText = payload.messages[0].content[0].text as string;
        expect(promptText).toContain("Extract document/page headers when visible.");
        expect(promptText).toContain("Extract document/page footers when visible.");
        expect(payload.messages[0].content[1]).toMatchObject({
            type: "image",
            source: {
                type: "base64",
                media_type: "image/png",
                data: "QUJD"
            }
        });
    });

    it("includes explicit OCR guidance in the prompt instructions when input.prompt is provided", async () => {
        const client = {
            messages: {
                create: vi.fn().mockResolvedValue({
                    id: "anthropic-ocr-10b",
                    content: [{ type: "text", text: "{}" }]
                })
            }
        } as any;

        const cap = new AnthropicOCRCapabilityImpl(makeProvider(), client);
        await cap.ocr(
            {
                input: {
                    file: "https://example.com/doc.pdf",
                    mimeType: "application/pdf",
                    prompt: "Preserve handwritten notes."
                }
            } as any,
            new MultiModalExecutionContext()
        );

        const payload = client.messages.create.mock.calls[0][0];
        expect(payload.messages[0].content[0].text).toContain("OCR guidance: Preserve handwritten notes.");
    });

    it("includes structured prompt instructions for schema-driven OCR requests", async () => {
        const client = {
            messages: {
                create: vi.fn().mockResolvedValue({
                    id: "anthropic-ocr-10c",
                    content: [{ type: "text", text: "{}" }]
                })
            }
        } as any;

        const cap = new AnthropicOCRCapabilityImpl(makeProvider(), client);
        await cap.ocr(
            {
                input: {
                    file: "https://example.com/doc.pdf",
                    mimeType: "application/pdf",
                    language: "fr",
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
                }
            } as any,
            new MultiModalExecutionContext()
        );

        const promptText = client.messages.create.mock.calls[0][0].messages[0].content[0].text as string;
        expect(promptText).toContain("Language hint: fr");
        expect(promptText).toContain("Structured extraction mode: document");
        expect(promptText).toContain("Structured extraction prompt: Extract invoice fields.");
        expect(promptText).toContain("Structured extraction schema name: invoice_schema");
        expect(promptText).toContain('"invoiceNumber"');
        expect(promptText).toContain("Extract document/page headers when visible.");
        expect(promptText).toContain("Extract document/page footers when visible.");
        expect(promptText).toContain("Represent tables using html when present.");
    });

    it("uses URL-backed image reference inputs", async () => {
        const client = {
            messages: {
                create: vi.fn().mockResolvedValue({
                    id: "anthropic-ocr-11",
                    content: [{ type: "text", text: "{}" }]
                })
            }
        } as any;

        const cap = new AnthropicOCRCapabilityImpl(makeProvider(), client);
        await cap.ocr(
            {
                input: {
                    images: [{ id: "img-2", sourceType: "url", url: "https://example.com/from-images.webp" }]
                }
            } as any,
            new MultiModalExecutionContext()
        );

        const payload = client.messages.create.mock.calls[0][0];
        expect(payload.messages[0].content[1]).toMatchObject({
            type: "image",
            source: {
                type: "url",
                url: "https://example.com/from-images.webp"
            }
        });
    });

    it("normalizes bbox annotations, page/header/footer fallbacks, and request-id fallback ids", async () => {
        const client = {
            messages: {
                create: vi.fn().mockResolvedValue({
                    content: [
                        { type: "tool_result", text: "ignored" },
                        {
                            type: "text",
                            text: JSON.stringify({
                                pages: [
                                    { fullText: "Page one body" },
                                    { pageNumber: 2, fullText: "" }
                                ],
                                annotations: [
                                    {
                                        type: "bbox",
                                        label: "total",
                                        text: "42.00",
                                        pageNumber: 1
                                    },
                                    {
                                        type: "document",
                                        data: { vendor: "ACME" }
                                    },
                                    null
                                ],
                                headers: [{ text: "Header fallback" }],
                                footers: [{ text: "Footer fallback" }]
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
                    file: "https://example.com/doc.pdf",
                    mimeType: "application/pdf"
                },
                context: { requestId: "anthropic-fallback-id" }
            } as any,
            new MultiModalExecutionContext()
        );

        expect(response.id).toBe("anthropic-fallback-id");
        expect(response.output[0]?.fullText).toBe("Page one body");
        expect(response.output[0]?.pages).toEqual([{ pageNumber: 1, fullText: "Page one body", text: [{ text: "Page one body" }] }]);
        expect(response.output[0]?.annotations).toEqual([
            { type: "bbox", label: "total", text: "42.00", pageNumber: 1 },
            { type: "document", data: { vendor: "ACME" } }
        ]);
        expect(response.output[0]?.headers).toEqual([{ pageNumber: 1, text: "Header fallback" }]);
        expect(response.output[0]?.footers).toEqual([{ pageNumber: 1, text: "Footer fallback" }]);
    });

    it("treats image-looking remote URLs as image parts and rejects unsupported remote URLs", async () => {
        const client = {
            messages: {
                create: vi.fn().mockResolvedValue({
                    id: "anthropic-ocr-12",
                    content: [{ type: "text", text: "{}" }]
                })
            }
        } as any;

        const cap = new AnthropicOCRCapabilityImpl(makeProvider(), client);
        await cap.ocr(
            {
                input: {
                    file: "https://example.com/scan.gif",
                    mimeType: "text/plain"
                }
            } as any,
            new MultiModalExecutionContext()
        );

        expect(client.messages.create.mock.calls[0][0].messages[0].content[1]).toMatchObject({
            type: "image",
            source: {
                type: "url",
                url: "https://example.com/scan.gif"
            }
        });

        await expect(
            cap.ocr(
                {
                    input: {
                        file: "https://example.com/archive.bin"
                    }
                } as any,
                new MultiModalExecutionContext()
            )
        ).rejects.toThrow("Unsupported Anthropic OCR input type");
    });
});
