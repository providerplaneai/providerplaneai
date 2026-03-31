import { describe, expect, it, vi } from "vitest";
import { MultiModalExecutionContext } from "#root/index.js";
import { OpenAIOCRCapabilityImpl } from "#root/providers/openai/capabilities/OpenAIOCRCapabilityImpl.js";

function makeProvider() {
    return {
        ensureInitialized: vi.fn(),
        getMergedOptions: vi.fn(() => ({
            model: "gpt-4.1",
            modelParams: {},
            providerParams: {}
        }))
    } as any;
}

describe("OpenAIOCRCapabilityImpl", () => {
    it("extracts OCR text from OpenAI function output", async () => {
        const client = {
            responses: {
                create: vi.fn().mockResolvedValue({
                    id: "openai-ocr-1",
                    status: "completed",
                    output: [
                        {
                            type: "function_call",
                            name: "ocr_extract",
                            arguments: JSON.stringify({
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

        const cap = new OpenAIOCRCapabilityImpl(makeProvider(), client);
        const response = await cap.ocr(
            {
                input: {
                    file: "https://example.com/doc.png",
                    mimeType: "image/png",
                    language: "en"
                },
                context: { requestId: "ocr-o-1" }
            } as any,
            new MultiModalExecutionContext()
        );

        expect(response.output[0]?.fullText).toContain("Cloud Computing Essentials");
        expect(response.output[0]?.pages?.[0]?.pageNumber).toBe(1);
        expect(response.output[0]?.headers?.[0]?.text).toBe("ASSIGNMENT");
        expect(response.output[0]?.footers?.[0]?.text).toBe("at skillbuilder.aws");
        expect(response.metadata?.provider).toBe("openai");
    });

    it("includes structured annotations when OpenAI returns them", async () => {
        const client = {
            responses: {
                create: vi.fn().mockResolvedValue({
                    id: "openai-ocr-2",
                    status: "completed",
                    output: [
                        {
                            type: "function_call",
                            name: "ocr_extract",
                            arguments: JSON.stringify({
                                fullText: "Cloud Computing Essentials",
                                annotations: [
                                    {
                                        type: "document",
                                        text: "{\"mainTitle\":\"Cloud Computing Essentials\"}",
                                        data: { mainTitle: "Cloud Computing Essentials" }
                                    }
                                ]
                            })
                        }
                    ]
                })
            }
        } as any;

        const cap = new OpenAIOCRCapabilityImpl(makeProvider(), client);
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

    it("falls back to output text when no function call payload is available", async () => {
        const client = {
            responses: {
                create: vi.fn().mockResolvedValue({
                    id: "openai-ocr-3",
                    status: "completed",
                    output: [
                        {
                            type: "message",
                            role: "assistant",
                            content: [{ type: "output_text", text: "Plain OCR output without JSON" }]
                        }
                    ]
                })
            }
        } as any;

        const cap = new OpenAIOCRCapabilityImpl(makeProvider(), client);
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

    it("does not send unsupported mime_type or filename fields in OpenAI OCR file content", async () => {
        const client = {
            responses: {
                create: vi.fn().mockResolvedValue({
                    id: "openai-ocr-4",
                    status: "completed",
                    output: []
                })
            }
        } as any;

        const cap = new OpenAIOCRCapabilityImpl(makeProvider(), client);
        await cap.ocr(
            {
                input: {
                    file: "https://example.com/doc.pdf",
                    filename: "doc.pdf",
                    mimeType: "application/pdf"
                }
            } as any,
            new MultiModalExecutionContext()
        );

        const payload = client.responses.create.mock.calls[0][0];
        const filePart = payload.input[0].content.find((part: any) => part.type === "input_file");
        expect(filePart).toBeDefined();
        expect("mime_type" in filePart).toBe(false);
        expect("filename" in filePart).toBe(false);
    });

    it("uses input_image for local image OCR files", async () => {
        const client = {
            responses: {
                create: vi.fn().mockResolvedValue({
                    id: "openai-ocr-5",
                    status: "completed",
                    output: []
                })
            }
        } as any;

        const cap = new OpenAIOCRCapabilityImpl(makeProvider(), client);
        await cap.ocr(
            {
                input: {
                    file: Buffer.from("fake-image"),
                    mimeType: "image/png"
                }
            } as any,
            new MultiModalExecutionContext()
        );

        const payload = client.responses.create.mock.calls[0][0];
        const imagePart = payload.input[0].content.find((part: any) => part.type === "input_image");
        expect(imagePart).toBeDefined();
        expect(String(imagePart.image_url)).toContain("data:image/png;base64,");
        expect(payload.input[0].content.some((part: any) => part.type === "input_file")).toBe(false);
    });

    it("uploads local PDFs and uses file-backed OCR request content", async () => {
        const client = {
            files: {
                create: vi.fn().mockResolvedValue({
                    id: "file-pdf-123"
                })
            },
            responses: {
                create: vi.fn().mockResolvedValue({
                    id: "openai-ocr-pdf-1",
                    status: "completed",
                    output: []
                })
            }
        } as any;

        const cap = new OpenAIOCRCapabilityImpl(makeProvider(), client);
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

        expect(client.files.create).toHaveBeenCalledTimes(1);
        expect(client.files.create.mock.calls[0][0].purpose).toBe("user_data");

        const payload = client.responses.create.mock.calls[0][0];
        const filePart = payload.input[0].content.find((part: any) => part.type === "input_file");
        expect(filePart).toBeDefined();
        expect(filePart.file_id).toBe("file-pdf-123");
        expect("file_url" in filePart).toBe(false);
        expect("filename" in filePart).toBe(false);
        expect("file_data" in filePart).toBe(false);
    });

    it("uploads local plain-text OCR files as file-backed input instead of file_url data URIs", async () => {
        const client = {
            files: {
                create: vi.fn().mockResolvedValue({
                    id: "file-text-123"
                })
            },
            responses: {
                create: vi.fn().mockResolvedValue({
                    id: "openai-ocr-text-1",
                    status: "completed",
                    output: []
                })
            }
        } as any;

        const cap = new OpenAIOCRCapabilityImpl(makeProvider(), client);
        await cap.ocr(
            {
                input: {
                    file: Buffer.from("plain text fixture"),
                    filename: "fixture.txt",
                    mimeType: "text/plain"
                }
            } as any,
            new MultiModalExecutionContext()
        );

        expect(client.files.create).toHaveBeenCalledTimes(1);
        const payload = client.responses.create.mock.calls[0][0];
        const filePart = payload.input[0].content.find((part: any) => part.type === "input_file");
        expect(filePart).toBeDefined();
        expect(filePart.file_id).toBe("file-text-123");
        expect("file_url" in filePart).toBe(false);
    });

    it("defensively normalizes non-string OCR payload fields", async () => {
        const client = {
            responses: {
                create: vi.fn().mockResolvedValue({
                    id: "openai-ocr-6",
                    status: "completed",
                    output: [
                        {
                            type: "function_call",
                            name: "ocr_extract",
                            arguments: JSON.stringify({
                                fullText: { title: "Cloud Computing Essentials" },
                                language: ["en"],
                                pages: [{ pageNumber: 1, fullText: ["Line 1", "Line 2"] }],
                                annotations: [{ type: "document", text: { summary: "Assignment details" } }]
                            })
                        }
                    ]
                })
            }
        } as any;

        const cap = new OpenAIOCRCapabilityImpl(makeProvider(), client);
        const response = await cap.ocr(
            {
                input: {
                    file: "https://example.com/doc.png",
                    mimeType: "image/png"
                }
            } as any,
            new MultiModalExecutionContext()
        );

        expect(response.output[0]?.fullText).toBe('{"title":"Cloud Computing Essentials"}');
        expect(response.output[0]?.language).toBe("en");
        expect(response.output[0]?.pages?.[0]?.fullText).toBe("Line 1\nLine 2");
        expect(response.output[0]?.annotations?.[0]?.text).toBe('{"summary":"Assignment details"}');
    });

    it("rejects degenerate boolean-only OCR payloads instead of treating them as valid text", async () => {
        const client = {
            responses: {
                create: vi.fn().mockResolvedValue({
                    id: "openai-ocr-7",
                    status: "completed",
                    output: [
                        {
                            type: "function_call",
                            name: "ocr_extract",
                            arguments: JSON.stringify({
                                fullText: true,
                                language: "en"
                            })
                        }
                    ]
                })
            }
        } as any;

        const cap = new OpenAIOCRCapabilityImpl(makeProvider(), client);
        const response = await cap.ocr(
            {
                input: {
                    file: "https://example.com/doc.png",
                    mimeType: "image/png"
                }
            } as any,
            new MultiModalExecutionContext()
        );

        expect(response.output[0]?.fullText).toBeUndefined();
        expect(response.output[0]?.text).toBeUndefined();
        expect(response.output[0]?.language).toBe("en");
    });
});
