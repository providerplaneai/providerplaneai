import { describe, expect, it, vi } from "vitest";
import { MultiModalExecutionContext } from "#root/index.js";
import { OpenAIOCRCapabilityImpl } from "#root/providers/openai/capabilities/OpenAIOCRCapabilityImpl.js";
import { Readable } from "node:stream";
import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

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

    it("rejects aborted requests, missing sources, and mixed file/images sources", async () => {
        const client = {
            responses: {
                create: vi.fn()
            }
        } as any;

        const cap = new OpenAIOCRCapabilityImpl(makeProvider(), client);
        const controller = new AbortController();
        controller.abort();

        await expect(cap.ocr({ input: { file: "https://example.com/doc.pdf" } } as any, new MultiModalExecutionContext(), controller.signal)).rejects.toThrow(
            "OCR request aborted before execution"
        );

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
        ).rejects.toThrow("OpenAI OCR accepts either `file` or `images`, not both");
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

    it("builds input_image parts for images without an explicit mime type when the URL looks image-like", async () => {
        const client = {
            responses: {
                create: vi.fn().mockResolvedValue({
                    id: "openai-ocr-8",
                    status: "completed",
                    output: []
                })
            }
        } as any;

        const cap = new OpenAIOCRCapabilityImpl(makeProvider(), client);
        await cap.ocr(
            {
                input: {
                    file: "https://example.com/doc-image.webp"
                }
            } as any,
            new MultiModalExecutionContext()
        );

        const payload = client.responses.create.mock.calls[0][0];
        const imagePart = payload.input[0].content.find((part: any) => part.type === "input_image");
        expect(imagePart).toBeDefined();
        expect(imagePart.image_url).toBe("https://example.com/doc-image.webp");
    });

    it("treats image data URIs as input_image content", async () => {
        const client = {
            responses: {
                create: vi.fn().mockResolvedValue({
                    id: "openai-ocr-9",
                    status: "completed",
                    output: []
                })
            }
        } as any;

        const cap = new OpenAIOCRCapabilityImpl(makeProvider(), client);
        await cap.ocr(
            {
                input: {
                    file: "data:image/png;base64,QUJD"
                }
            } as any,
            new MultiModalExecutionContext()
        );

        const payload = client.responses.create.mock.calls[0][0];
        const imagePart = payload.input[0].content.find((part: any) => part.type === "input_image");
        expect(imagePart).toBeDefined();
        expect(imagePart.image_url).toBe("data:image/png;base64,QUJD");
    });

    it("uploads PDF and generic document data URIs as file-backed OCR content", async () => {
        const client = {
            files: {
                create: vi.fn().mockResolvedValueOnce({ id: "file-datauri-pdf" }).mockResolvedValueOnce({ id: "file-datauri-text" })
            },
            responses: {
                create: vi.fn().mockResolvedValue({
                    id: "openai-ocr-datauri",
                    status: "completed",
                    output: []
                })
            }
        } as any;

        const cap = new OpenAIOCRCapabilityImpl(makeProvider(), client);
        await cap.ocr(
            {
                input: {
                    file: "data:application/pdf;base64,JVBERi0xLjc=",
                    filename: "inline.pdf"
                }
            } as any,
            new MultiModalExecutionContext()
        );

        await cap.ocr(
            {
                input: {
                    file: "data:text/plain;base64,QUJDRA==",
                    filename: "inline.txt"
                }
            } as any,
            new MultiModalExecutionContext()
        );

        expect(client.responses.create.mock.calls[0][0].input[0].content.find((part: any) => part.type === "input_file")?.file_id).toBe(
            "file-datauri-pdf"
        );
        expect(client.responses.create.mock.calls[1][0].input[0].content.find((part: any) => part.type === "input_file")?.file_id).toBe(
            "file-datauri-text"
        );
    });

    it("uploads Blob PDF inputs as file-backed OCR content", async () => {
        const client = {
            files: {
                create: vi.fn().mockResolvedValue({ id: "file-blob-pdf" })
            },
            responses: {
                create: vi.fn().mockResolvedValue({
                    id: "openai-ocr-10",
                    status: "completed",
                    output: []
                })
            }
        } as any;

        const pdfBlob = new Blob([Buffer.from("%PDF fake")], { type: "application/pdf" });
        const cap = new OpenAIOCRCapabilityImpl(makeProvider(), client);
        await cap.ocr(
            {
                input: {
                    file: pdfBlob,
                    filename: "blob.pdf"
                }
            } as any,
            new MultiModalExecutionContext()
        );

        const payload = client.responses.create.mock.calls[0][0];
        const filePart = payload.input[0].content.find((part: any) => part.type === "input_file");
        expect(filePart.file_id).toBe("file-blob-pdf");
    });

    it("routes Blob image and generic document inputs through the correct OpenAI OCR transport", async () => {
        const client = {
            files: {
                create: vi.fn().mockResolvedValueOnce({ id: "file-blob-text" })
            },
            responses: {
                create: vi.fn().mockResolvedValue({
                    id: "openai-ocr-blob-mixed",
                    status: "completed",
                    output: []
                })
            }
        } as any;

        const cap = new OpenAIOCRCapabilityImpl(makeProvider(), client);
        await cap.ocr(
            {
                input: {
                    file: new Blob([Buffer.from([1, 2, 3])], { type: "image/png" }),
                    filename: "blob-image.png"
                }
            } as any,
            new MultiModalExecutionContext()
        );

        await cap.ocr(
            {
                input: {
                    file: new Blob([Buffer.from("blob text")], { type: "text/plain" }),
                    filename: "blob-text.txt"
                }
            } as any,
            new MultiModalExecutionContext()
        );

        expect(client.responses.create.mock.calls[0][0].input[0].content.some((part: any) => part.type === "input_image")).toBe(true);
        expect(client.responses.create.mock.calls[1][0].input[0].content.find((part: any) => part.type === "input_file")?.file_id).toBe(
            "file-blob-text"
        );
    });

    it("uploads ArrayBuffer and readable-stream non-image inputs as file-backed OCR content", async () => {
        const client = {
            files: {
                create: vi.fn().mockResolvedValueOnce({ id: "file-arraybuffer" }).mockResolvedValueOnce({ id: "file-stream" })
            },
            responses: {
                create: vi.fn().mockResolvedValue({
                    id: "openai-ocr-11",
                    status: "completed",
                    output: []
                })
            }
        } as any;

        const cap = new OpenAIOCRCapabilityImpl(makeProvider(), client);

        await cap.ocr(
            {
                input: {
                    file: Uint8Array.from([1, 2, 3]).buffer,
                    filename: "sheet.xlsx",
                    mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                }
            } as any,
            new MultiModalExecutionContext()
        );

        await cap.ocr(
            {
                input: {
                    file: Readable.from([Buffer.from("streamed text")]),
                    filename: "notes.txt",
                    mimeType: "text/plain"
                }
            } as any,
            new MultiModalExecutionContext()
        );

        expect(client.files.create).toHaveBeenCalledTimes(2);
        expect(client.responses.create.mock.calls[0][0].input[0].content.some((part: any) => part.type === "input_file")).toBe(
            true
        );
        expect(client.responses.create.mock.calls[1][0].input[0].content.some((part: any) => part.type === "input_file")).toBe(
            true
        );
    });

    it("routes Uint8Array image, pdf, and generic document inputs through the correct OpenAI OCR transport", async () => {
        const client = {
            files: {
                create: vi.fn().mockResolvedValueOnce({ id: "file-u8-pdf" }).mockResolvedValueOnce({ id: "file-u8-doc" })
            },
            responses: {
                create: vi.fn().mockResolvedValue({
                    id: "openai-ocr-typed-u8",
                    status: "completed",
                    output: []
                })
            }
        } as any;

        const cap = new OpenAIOCRCapabilityImpl(makeProvider(), client);

        await cap.ocr(
            {
                input: {
                    file: Uint8Array.from([1, 2, 3]),
                    filename: "scan.png",
                    mimeType: "image/png"
                }
            } as any,
            new MultiModalExecutionContext()
        );

        await cap.ocr(
            {
                input: {
                    file: Uint8Array.from([4, 5, 6]),
                    filename: "typed.pdf",
                    mimeType: "application/pdf"
                }
            } as any,
            new MultiModalExecutionContext()
        );

        await cap.ocr(
            {
                input: {
                    file: Uint8Array.from([7, 8, 9]),
                    filename: "typed.txt",
                    mimeType: "text/plain"
                }
            } as any,
            new MultiModalExecutionContext()
        );

        expect(client.responses.create.mock.calls[0][0].input[0].content.some((part: any) => part.type === "input_image")).toBe(true);
        expect(client.responses.create.mock.calls[1][0].input[0].content.find((part: any) => part.type === "input_file")?.file_id).toBe(
            "file-u8-pdf"
        );
        expect(client.responses.create.mock.calls[2][0].input[0].content.find((part: any) => part.type === "input_file")?.file_id).toBe(
            "file-u8-doc"
        );
    });

    it("treats ArrayBuffer and readable-stream image inputs as input_image content", async () => {
        const client = {
            responses: {
                create: vi.fn().mockResolvedValue({
                    id: "openai-ocr-12",
                    status: "completed",
                    output: []
                })
            }
        } as any;

        const cap = new OpenAIOCRCapabilityImpl(makeProvider(), client);

        await cap.ocr(
            {
                input: {
                    file: Uint8Array.from([1, 2, 3]).buffer,
                    filename: "scan.png",
                    mimeType: "image/png"
                }
            } as any,
            new MultiModalExecutionContext()
        );

        await cap.ocr(
            {
                input: {
                    file: Readable.from([Buffer.from([4, 5, 6])]),
                    filename: "streamed.png",
                    mimeType: "image/png"
                }
            } as any,
            new MultiModalExecutionContext()
        );

        const firstPayload = client.responses.create.mock.calls[0][0];
        const secondPayload = client.responses.create.mock.calls[1][0];
        expect(firstPayload.input[0].content.some((part: any) => part.type === "input_image")).toBe(true);
        expect(secondPayload.input[0].content.some((part: any) => part.type === "input_image")).toBe(true);
    });

    it("uploads ArrayBuffer and readable-stream PDF inputs as file-backed OCR content", async () => {
        const client = {
            files: {
                create: vi.fn().mockResolvedValueOnce({ id: "file-ab-pdf" }).mockResolvedValueOnce({ id: "file-stream-pdf" })
            },
            responses: {
                create: vi.fn().mockResolvedValue({
                    id: "openai-ocr-typed-pdf",
                    status: "completed",
                    output: []
                })
            }
        } as any;

        const cap = new OpenAIOCRCapabilityImpl(makeProvider(), client);

        await cap.ocr(
            {
                input: {
                    file: Uint8Array.from([1, 2, 3]).buffer,
                    filename: "arraybuffer.pdf",
                    mimeType: "application/pdf"
                }
            } as any,
            new MultiModalExecutionContext()
        );

        await cap.ocr(
            {
                input: {
                    file: Readable.from([Buffer.from("%PDF-stream")]),
                    filename: "stream.pdf",
                    mimeType: "application/pdf"
                }
            } as any,
            new MultiModalExecutionContext()
        );

        expect(client.responses.create.mock.calls[0][0].input[0].content.find((part: any) => part.type === "input_file")?.file_id).toBe(
            "file-ab-pdf"
        );
        expect(client.responses.create.mock.calls[1][0].input[0].content.find((part: any) => part.type === "input_file")?.file_id).toBe(
            "file-stream-pdf"
        );
    });

    it("routes local image, pdf, and generic document paths through the correct OpenAI OCR transport", async () => {
        const client = {
            files: {
                create: vi.fn().mockResolvedValueOnce({ id: "file-path-pdf" }).mockResolvedValueOnce({ id: "file-path-text" })
            },
            responses: {
                create: vi.fn().mockResolvedValue({
                    id: "openai-ocr-paths",
                    status: "completed",
                    output: []
                })
            }
        } as any;

        const dir = await mkdtemp(join(tmpdir(), "openai-ocr-"));
        const imagePath = join(dir, "scan.png");
        const pdfPath = join(dir, "scan.pdf");
        const textPath = join(dir, "notes.txt");
        await writeFile(imagePath, Buffer.from([1, 2, 3]));
        await writeFile(pdfPath, Buffer.from("%PDF fake"));
        await writeFile(textPath, "hello");

        const cap = new OpenAIOCRCapabilityImpl(makeProvider(), client);

        await cap.ocr({ input: { file: imagePath } } as any, new MultiModalExecutionContext());
        await cap.ocr({ input: { file: pdfPath } } as any, new MultiModalExecutionContext());
        await cap.ocr({ input: { file: textPath } } as any, new MultiModalExecutionContext());

        expect(client.responses.create.mock.calls[0][0].input[0].content.some((part: any) => part.type === "input_image")).toBe(true);
        expect(client.responses.create.mock.calls[1][0].input[0].content.find((part: any) => part.type === "input_file")?.file_id).toBe(
            "file-path-pdf"
        );
        expect(client.responses.create.mock.calls[2][0].input[0].content.find((part: any) => part.type === "input_file")?.file_id).toBe(
            "file-path-text"
        );
    });

    it("rejects unsupported OCR input types", async () => {
        const client = {
            responses: {
                create: vi.fn()
            }
        } as any;

        const cap = new OpenAIOCRCapabilityImpl(makeProvider(), client);
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
        ).rejects.toThrow("Unsupported OpenAI OCR input type");
    });

    it("treats undefined parsed payloads as degenerate in the helper guard", () => {
        const cap = new OpenAIOCRCapabilityImpl(makeProvider(), {} as any);
        expect((cap as any).isDegenerateParsedPayload(undefined)).toBe(true);
    });

    it("uses image reference inputs for OCR images and includes structured prompt instructions", async () => {
        const client = {
            responses: {
                create: vi.fn().mockResolvedValue({
                    id: "openai-ocr-images-1",
                    status: "completed",
                    output: []
                })
            }
        } as any;

        const cap = new OpenAIOCRCapabilityImpl(makeProvider(), client);
        await cap.ocr(
            {
                input: {
                    images: [{ id: "img-1", sourceType: "url", url: "https://example.com/from-images.png" }],
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
                }
            } as any,
            new MultiModalExecutionContext()
        );

        const payload = client.responses.create.mock.calls[0][0];
        const promptText = payload.input[0].content[0].text as string;
        expect(promptText).toContain("Language hint: fr");
        expect(promptText).toContain("OCR guidance: Preserve handwritten notes.");
        expect(promptText).toContain("Structured extraction mode: document");
        expect(promptText).toContain("Structured extraction prompt: Extract invoice fields.");
        expect(promptText).toContain("Structured extraction schema name: invoice_schema");
        expect(promptText).toContain('"invoiceNumber"');
        expect(promptText).toContain("Extract headers when visible.");
        expect(promptText).toContain("Extract footers when visible.");
        expect(promptText).toContain("Represent tables using html when present.");
        expect(payload.input[0].content[1]).toMatchObject({
            type: "input_image",
            image_url: "https://example.com/from-images.png"
        });
    });

    it("falls back to request id, page text, and empty output text for degenerate OpenAI OCR responses", async () => {
        const client = {
            responses: {
                create: vi.fn()
                    .mockResolvedValueOnce({
                        status: "completed",
                        output: [
                            {
                                type: "function_call",
                                name: "ocr_extract",
                                arguments: JSON.stringify({
                                    pages: [{ fullText: "Page one body" }, { pageNumber: 2, fullText: "" }],
                                    annotations: [{ type: "bbox", label: "total", text: "42.00", pageNumber: 1 }],
                                    headers: [{ text: "Header fallback" }],
                                    footers: [{ text: "Footer fallback" }]
                                })
                            }
                        ]
                    })
                    .mockResolvedValueOnce({
                        id: "openai-ocr-empty-output",
                        status: "completed",
                        output: [{ type: "function_call", name: "ocr_extract", arguments: JSON.stringify({ fullText: true }) }]
                    })
            }
        } as any;

        const cap = new OpenAIOCRCapabilityImpl(makeProvider(), client);

        const normalized = await cap.ocr(
            {
                input: {
                    file: "https://example.com/doc.pdf",
                    mimeType: "application/pdf"
                },
                context: { requestId: "openai-ocr-fallback-id" }
            } as any,
            new MultiModalExecutionContext()
        );

        expect(normalized.id).toBe("openai-ocr-fallback-id");
        expect(normalized.output[0]?.fullText).toBe("Page one body");
        expect(normalized.output[0]?.pages).toEqual([{ pageNumber: 1, fullText: "Page one body", text: [{ text: "Page one body" }] }]);
        expect(normalized.output[0]?.headers).toEqual([{ pageNumber: 1, text: "Header fallback" }]);
        expect(normalized.output[0]?.footers).toEqual([{ pageNumber: 1, text: "Footer fallback" }]);

        const degenerate = await cap.ocr(
            {
                input: {
                    file: "https://example.com/degenerate.pdf",
                    mimeType: "application/pdf"
                }
            } as any,
            new MultiModalExecutionContext()
        );

        expect(degenerate.output[0]?.fullText).toBeUndefined();
        expect(degenerate.output[0]?.text).toBeUndefined();
    });
});
