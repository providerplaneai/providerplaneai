/**
 * @module providers/gemini/capabilities/GeminiOCRCapabilityImpl.ts
 * @description Provider implementations and capability adapters.
 */
import { GoogleGenAI } from "@google/genai";
import { access, readFile } from "node:fs/promises";
import {
    AIProvider,
    AIRequest,
    AIResponse,
    BaseProvider,
    CapabilityKeys,
    ClientFileInputSource,
    ClientOCRRequest,
    ClientReferenceImage,
    inferMimeTypeFromFilename,
    MultiModalExecutionContext,
    NormalizedOCRDocument,
    OCRCapability,
    OCRText,
    parseDataUri,
    parseBestEffortJson,
    stripDataUriPrefix
} from "#root/index.js";

const DEFAULT_GEMINI_OCR_MODEL = "gemini-2.5-pro";

type GeminiOCRPayload = {
    fullText?: string;
    language?: string;
    pages?: Array<{
        pageNumber?: number;
        fullText?: string;
    }>;
    headers?: Array<{
        pageNumber?: number;
        text?: string;
    }>;
    footers?: Array<{
        pageNumber?: number;
        text?: string;
    }>;
    annotations?: Array<{
        type?: "document" | "bbox";
        label?: string;
        text?: string;
        data?: Record<string, unknown> | unknown[];
        pageNumber?: number;
    }>;
};

/**
 * Gemini OCR capability implementation.
 *
 * Gemini does not expose a dedicated OCR endpoint here, so OCR is implemented as
 * prompt-driven multimodal extraction over images/documents via `generateContent`.
 *
 * v1 scope:
 * - plain OCR for local files, data URIs, remote URLs, and image inputs
 * - best-effort structured extraction through `request.structured`
 * - no OCR streaming
 */
export class GeminiOCRCapabilityImpl implements OCRCapability<ClientOCRRequest, NormalizedOCRDocument[]> {
    constructor(
        private readonly provider: BaseProvider,
        private readonly client: GoogleGenAI
    ) {}

    async ocr(
        request: AIRequest<ClientOCRRequest>,
        _ctx: MultiModalExecutionContext,
        signal?: AbortSignal
    ): Promise<AIResponse<NormalizedOCRDocument[]>> {
        this.provider.ensureInitialized();

        if (signal?.aborted) {
            throw new Error("OCR request aborted before execution");
        }

        const { input, options, context } = request;
        this.assertHasSource(input);

        const merged = this.provider.getMergedOptions(CapabilityKeys.OCRCapabilityKey, options);
        const model = (merged.model ?? DEFAULT_GEMINI_OCR_MODEL).replace(/^models\//, "");
        const content = await this.buildGeminiUserContent(input);

        const response = await this.client.models.generateContent({
            model,
            contents: [content],
            config: {
                temperature: 0,
                ...(merged.modelParams ?? {})
            },
            ...(merged.providerParams ?? {})
        } as any);

        const responseId = response?.responseId ?? context?.requestId ?? crypto.randomUUID();
        const responseText = this.extractGeminiResponseText(response);
        const parsedItems = parseBestEffortJson<GeminiOCRPayload>(this.stripMarkdownCodeFence(responseText));
        const document = this.normalizeOCRDocument(input, parsedItems[0], responseText, responseId);

        return {
            output: [document],
            multimodalArtifacts: { ocr: [document] },
            id: responseId,
            rawResponse: response,
            metadata: {
                ...(context?.metadata ?? {}),
                provider: AIProvider.Gemini,
                model,
                status: "completed",
                requestId: context?.requestId
            }
        };
    }

    private assertHasSource(input: ClientOCRRequest): void {
        const imageCount = input.images?.length ?? 0;
        const hasFile = input.file !== undefined;
        if (!hasFile && imageCount === 0) {
            throw new Error("OCR requires either `file` or one or more `images`");
        }
        if (hasFile && imageCount > 0) {
            throw new Error("Gemini OCR accepts either `file` or `images`, not both");
        }
    }

    private async buildGeminiUserContent(input: ClientOCRRequest): Promise<{
        role: "user";
        parts: Array<
            | { text: string }
            | { inlineData: { mimeType: string; data: string } }
            | { fileData: { mimeType: string; fileUri: string } }
        >;
    }> {
        const parts: Array<
            | { text: string }
            | { inlineData: { mimeType: string; data: string } }
            | { fileData: { mimeType: string; fileUri: string } }
        > = [{ text: this.buildOCRPrompt(input) }];

        if (input.images?.length) {
            for (const image of input.images) {
                parts.push(this.toGeminiImagePart(image));
            }
        } else if (input.file !== undefined) {
            parts.push(await this.toGeminiFilePart(input.file, input.mimeType, input.filename));
        }

        return {
            role: "user",
            parts
        };
    }

    private buildOCRPrompt(input: ClientOCRRequest): string {
        const basePrompt = [
            "You are an OCR and document extraction system.",
            "Return ONLY valid JSON.",
            "Do not wrap the result in markdown fences.",
            "Preserve readable text exactly where possible."
        ];

        const targetShape = [
            "{",
            '  "fullText"?: string,',
            '  "language"?: string,',
            '  "pages"?: [{ "pageNumber"?: number, "fullText"?: string }],',
            '  "headers"?: [{ "pageNumber"?: number, "text"?: string }],',
            '  "footers"?: [{ "pageNumber"?: number, "text"?: string }],',
            '  "annotations"?: [{ "type"?: "document" | "bbox", "label"?: string, "text"?: string, "data"?: object | array, "pageNumber"?: number }]',
            "}"
        ].join("\n");

        const instructions = [
            basePrompt.join("\n"),
            `Return JSON matching this shape:\n${targetShape}`
        ];

        if (input.language) {
            instructions.push(`Language hint: ${input.language}`);
        }

        if (input.prompt) {
            instructions.push(`OCR guidance: ${input.prompt}`);
        }

        if (input.structured?.annotationMode) {
            instructions.push(`Structured extraction mode: ${input.structured.annotationMode}`);
        }

        if (input.structured?.annotationPrompt) {
            instructions.push(`Structured extraction prompt: ${input.structured.annotationPrompt}`);
        }

        if (input.structured?.annotationSchema) {
            instructions.push(
                `Structured extraction schema name: ${input.structured.annotationSchema.name}\n` +
                    `Schema:\n${JSON.stringify(input.structured.annotationSchema.schema)}`
            );
        }

        if (input.structured?.extractHeaders) {
            instructions.push("Extract document/page headers when visible.");
        }

        if (input.structured?.extractFooters) {
            instructions.push("Extract document/page footers when visible.");
        }

        if (input.structured?.tableFormat) {
            instructions.push(`Represent tables using ${input.structured.tableFormat} when present.`);
        }

        return instructions.join("\n\n");
    }

    private normalizeOCRDocument(
        input: ClientOCRRequest,
        parsed: GeminiOCRPayload | undefined,
        rawText: string,
        responseId: string
    ): NormalizedOCRDocument {
        const parsedPages = parsed?.pages
            ?.map((page, index) => ({
                pageNumber: page.pageNumber ?? index + 1,
                fullText: page.fullText?.trim() || undefined,
                text: page.fullText?.trim() ? ([{ text: page.fullText.trim() }] satisfies OCRText[]) : undefined
            }))
            .filter((page) => page.fullText || page.text);

        const pageTexts = parsedPages?.map((page) => page.fullText).filter((value): value is string => Boolean(value)) ?? [];
        const fullText = (parsed?.fullText?.trim() || pageTexts.join("\n\n").trim() || rawText.trim()) || undefined;

        return {
            id: responseId,
            fullText,
            text: fullText ? [{ text: fullText }] : undefined,
            pages: parsedPages,
            language: parsed?.language ?? input.language,
            pageCount: parsedPages?.length,
            fileName: input.filename,
            mimeType: input.mimeType,
            sourceImageId: input.images?.[0]?.id,
            annotations: parsed?.annotations
                ?.filter((annotation) => annotation && (annotation.text || annotation.data))
                .map((annotation) => ({
                    type: annotation.type === "bbox" ? "bbox" : "document",
                    ...(annotation.label ? { label: annotation.label } : {}),
                    ...(this.normalizeAnnotationText(annotation.text, annotation.data, input.structured?.annotationPrompt)
                        ? { text: this.normalizeAnnotationText(annotation.text, annotation.data, input.structured?.annotationPrompt) }
                        : {}),
                    ...(annotation.data ? { data: annotation.data } : {}),
                    ...(annotation.pageNumber ? { pageNumber: annotation.pageNumber } : {})
                })),
            headers: parsed?.headers
                ?.filter((section) => section?.text)
                .map((section, index) => ({
                    pageNumber: section.pageNumber ?? index + 1,
                    text: String(section.text)
                })),
            footers: parsed?.footers
                ?.filter((section) => section?.text)
                .map((section, index) => ({
                    pageNumber: section.pageNumber ?? index + 1,
                    text: String(section.text)
                })),
            metadata: {
                provider: AIProvider.Gemini,
                status: "completed",
                rawParsed: parsed
            }
        };
    }

    private normalizeAnnotationText(
        text: string | undefined,
        data: Record<string, unknown> | unknown[] | undefined,
        annotationPrompt: string | undefined
    ): string | undefined {
        const normalizedText = typeof text === "string" ? text.trim() : undefined;
        if (!normalizedText) {
            return undefined;
        }

        const normalizedPrompt = annotationPrompt?.trim();
        if (normalizedPrompt && normalizedText === normalizedPrompt) {
            return data ? JSON.stringify(data) : undefined;
        }

        return normalizedText;
    }

    private toGeminiImagePart(img: ClientReferenceImage) {
        const mimeType = img.mimeType ?? "image/png";

        if (typeof img.base64 === "string" && img.base64.length > 0) {
            return {
                inlineData: {
                    mimeType,
                    data: stripDataUriPrefix(img.base64)
                }
            };
        }

        if (typeof img.url === "string" && img.url.length > 0) {
            if (img.url.startsWith("data:")) {
                const parsed = parseDataUri(img.url);
                return {
                    inlineData: {
                        mimeType: parsed.mimeType ?? mimeType,
                        data: Buffer.from(parsed.bytes).toString("base64")
                    }
                };
            }

            return {
                fileData: {
                    mimeType,
                    fileUri: img.url
                }
            };
        }

        throw new Error("Gemini OCR image inputs require image.base64 or image.url");
    }

    private async toGeminiFilePart(file: ClientFileInputSource, mimeType?: string, filename?: string) {
        const resolvedMimeType = mimeType ?? inferMimeTypeFromFilename(filename) ?? "application/octet-stream";

        if (typeof file === "string") {
            if (/^https?:\/\//i.test(file)) {
                return {
                    fileData: {
                        mimeType: resolvedMimeType,
                        fileUri: file
                    }
                };
            }

            if (/^data:/i.test(file)) {
                const parsed = parseDataUri(file);
                return {
                    inlineData: {
                        mimeType: parsed.mimeType ?? resolvedMimeType,
                        data: Buffer.from(parsed.bytes).toString("base64")
                    }
                };
            }

            await access(file);
            const bytes = await readFile(file);
            return {
                inlineData: {
                    mimeType: mimeType ?? inferMimeTypeFromFilename(file) ?? resolvedMimeType,
                    data: Buffer.from(bytes).toString("base64")
                }
            };
        }

        if (typeof Blob !== "undefined" && file instanceof Blob) {
            const buffer = Buffer.from(await file.arrayBuffer());
            return {
                inlineData: {
                    mimeType: file.type || resolvedMimeType,
                    data: buffer.toString("base64")
                }
            };
        }

        if (typeof Buffer !== "undefined" && Buffer.isBuffer(file)) {
            return {
                inlineData: {
                    mimeType: resolvedMimeType,
                    data: Buffer.from(file).toString("base64")
                }
            };
        }

        if (file instanceof Uint8Array) {
            return {
                inlineData: {
                    mimeType: resolvedMimeType,
                    data: Buffer.from(file).toString("base64")
                }
            };
        }

        if (file instanceof ArrayBuffer) {
            return {
                inlineData: {
                    mimeType: resolvedMimeType,
                    data: Buffer.from(file).toString("base64")
                }
            };
        }

        if (this.isNodeReadableStream(file)) {
            const bytes = await this.readNodeStream(file, undefined);
            return {
                inlineData: {
                    mimeType: resolvedMimeType,
                    data: Buffer.from(bytes).toString("base64")
                }
            };
        }

        throw new Error("Unsupported Gemini OCR input type");
    }

    private extractGeminiResponseText(response: any): string {
        if (typeof response?.text === "string" && response.text.length > 0) {
            return response.text;
        }

        let text = "";
        const candidates = response?.candidates;
        if (!Array.isArray(candidates)) {
            return "";
        }

        for (const candidate of candidates) {
            const parts = candidate?.content?.parts;
            if (!Array.isArray(parts)) {
                continue;
            }
            for (const part of parts) {
                if (typeof part?.text === "string" && part.text.length > 0) {
                    text += text.length > 0 ? `\n${part.text}` : part.text;
                }
            }
        }

        return text;
    }

    private stripMarkdownCodeFence(value: string): string {
        const trimmed = value.trim();
        const match = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
        return match?.[1]?.trim() ?? trimmed;
    }

    private isNodeReadableStream(value: unknown): value is NodeJS.ReadableStream {
        return Boolean(value) && typeof (value as NodeJS.ReadableStream).pipe === "function";
    }

    private async readNodeStream(stream: NodeJS.ReadableStream, signal?: AbortSignal): Promise<Uint8Array> {
        const chunks: Buffer[] = [];

        for await (const chunk of stream as AsyncIterable<Buffer | Uint8Array | string>) {
            if (signal?.aborted) {
                throw new Error("OCR request aborted while reading stream input");
            }
            chunks.push(Buffer.from(chunk));
        }

        return new Uint8Array(Buffer.concat(chunks));
    }
}
