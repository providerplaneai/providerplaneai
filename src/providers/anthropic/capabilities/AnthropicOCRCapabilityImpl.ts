/**
 * @module providers/anthropic/capabilities/AnthropicOCRCapabilityImpl.ts
 * @description Provider implementations and capability adapters.
 */
import { access, readFile } from "node:fs/promises";
import Anthropic from "@anthropic-ai/sdk";
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

const DEFAULT_ANTHROPIC_OCR_MODEL = "claude-sonnet-4-5-20250929";

type AnthropicOCRPayload = {
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

export class AnthropicOCRCapabilityImpl implements OCRCapability<ClientOCRRequest, NormalizedOCRDocument[]> {
    constructor(
        private readonly provider: BaseProvider,
        private readonly client: Anthropic
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
        const response = await this.client.messages.create(
            {
                model: merged.model ?? DEFAULT_ANTHROPIC_OCR_MODEL,
                max_tokens: merged.modelParams?.max_tokens ?? 2048,
                messages: await this.buildOCRMessages(input),
                ...(merged.modelParams ?? {}),
                ...(merged.providerParams ?? {})
            },
            { signal }
        );

        const responseId = response.id ?? context?.requestId ?? crypto.randomUUID();
        const responseText = this.extractText(response);
        const parsedItems = parseBestEffortJson<AnthropicOCRPayload>(this.stripJsonFences(responseText));
        const document = this.normalizeOCRDocument(input, parsedItems[0], responseText, responseId);

        return {
            output: [document],
            multimodalArtifacts: { ocr: [document] },
            id: responseId,
            rawResponse: response,
            metadata: {
                ...(context?.metadata ?? {}),
                provider: AIProvider.Anthropic,
                model: merged.model,
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
            throw new Error("Anthropic OCR accepts either `file` or `images`, not both");
        }
    }

    private async buildOCRMessages(input: ClientOCRRequest): Promise<any[]> {
        const content: any[] = [{ type: "text", text: this.buildOCRPrompt(input) }];

        if (input.images?.length) {
            for (const image of input.images) {
                content.push(await this.toAnthropicImagePart(image));
            }
        } else if (input.file !== undefined) {
            content.push(await this.toAnthropicFilePart(input.file, input.mimeType, input.filename));
        }

        return [{ role: "user", content }];
    }

    private buildOCRPrompt(input: ClientOCRRequest): string {
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
            "You are an OCR and document extraction system.",
            "Return ONLY valid JSON.",
            "Do not wrap the result in markdown fences.",
            "Preserve readable text exactly where possible.",
            "Use strings for text fields or omit them entirely.",
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
        parsed: AnthropicOCRPayload | undefined,
        rawText: string,
        responseId: string
    ): NormalizedOCRDocument {
        const parsedPages = parsed?.pages
            ?.map((page, index) => ({
                pageNumber: page.pageNumber ?? index + 1,
                fullText: this.normalizeOptionalText(page.fullText),
                text: this.normalizeOptionalText(page.fullText)
                    ? ([{ text: this.normalizeOptionalText(page.fullText)! }] satisfies OCRText[])
                    : undefined
            }))
            .filter((page) => page.fullText || page.text);

        const pageTexts = parsedPages?.map((page) => page.fullText).filter((value): value is string => Boolean(value)) ?? [];
        const fullText = (this.normalizeOptionalText(parsed?.fullText) || pageTexts.join("\n\n").trim() || rawText.trim()) || undefined;

        return {
            id: responseId,
            fullText,
            text: fullText ? [{ text: fullText }] : undefined,
            pages: parsedPages,
            language: this.normalizeOptionalText(parsed?.language) ?? input.language,
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
                provider: AIProvider.Anthropic,
                status: "completed",
                rawParsed: parsed
            }
        };
    }

    private async toAnthropicImagePart(image: ClientReferenceImage) {
        if (image.base64) {
            return {
                type: "image",
                source: {
                    type: "base64",
                    media_type: image.mimeType ?? "image/png",
                    data: stripDataUriPrefix(image.base64)
                }
            };
        }

        if (image.url) {
            if (image.url.startsWith("data:")) {
                const parsed = parseDataUri(image.url);
                return {
                    type: "image",
                    source: {
                        type: "base64",
                        media_type: parsed.mimeType ?? image.mimeType ?? "image/png",
                        data: Buffer.from(parsed.bytes).toString("base64")
                    }
                };
            }

            return {
                type: "image",
                source: {
                    type: "url",
                    url: image.url
                }
            };
        }

        throw new Error("Anthropic OCR image inputs require image.base64 or image.url");
    }

    private async toAnthropicFilePart(file: ClientFileInputSource, mimeType?: string, filename?: string) {
        const resolvedMimeType = mimeType ?? inferMimeTypeFromFilename(filename) ?? "application/octet-stream";

        if (typeof file === "string") {
            if (/^https?:\/\//i.test(file)) {
                if (resolvedMimeType === "application/pdf") {
                    return {
                        type: "document",
                        source: {
                            type: "url",
                            url: file
                        },
                        ...(filename ? { title: filename } : {})
                    };
                }

                if (this.isImageMimeType(resolvedMimeType) || this.isLikelyImagePath(file)) {
                    return {
                        type: "image",
                        source: {
                            type: "url",
                            url: file
                        }
                    };
                }
            }

            if (/^data:/i.test(file)) {
                const parsed = parseDataUri(file);
                return this.base64SourcePart(
                    Buffer.from(parsed.bytes).toString("base64"),
                    parsed.mimeType ?? resolvedMimeType,
                    filename
                );
            }

            await access(file);
            const bytes = await readFile(file);
            const inferredMimeType = mimeType ?? inferMimeTypeFromFilename(file) ?? resolvedMimeType;
            return this.base64SourcePart(Buffer.from(bytes).toString("base64"), inferredMimeType, filename ?? this.basename(file));
        }

        if (typeof Blob !== "undefined" && file instanceof Blob) {
            const buffer = Buffer.from(await file.arrayBuffer());
            return this.base64SourcePart(buffer.toString("base64"), file.type || resolvedMimeType, filename);
        }

        if (typeof Buffer !== "undefined" && Buffer.isBuffer(file)) {
            return this.base64SourcePart(Buffer.from(file).toString("base64"), resolvedMimeType, filename);
        }

        if (file instanceof Uint8Array) {
            return this.base64SourcePart(Buffer.from(file).toString("base64"), resolvedMimeType, filename);
        }

        if (file instanceof ArrayBuffer) {
            return this.base64SourcePart(Buffer.from(file).toString("base64"), resolvedMimeType, filename);
        }

        if (this.isNodeReadableStream(file)) {
            const bytes = await this.readNodeStream(file, undefined);
            return this.base64SourcePart(Buffer.from(bytes).toString("base64"), resolvedMimeType, filename);
        }

        throw new Error("Unsupported Anthropic OCR input type");
    }

    private base64SourcePart(base64: string, mimeType: string, filename?: string) {
        if (mimeType === "application/pdf") {
            return {
                type: "document",
                source: {
                    type: "base64",
                    media_type: "application/pdf",
                    data: stripDataUriPrefix(base64)
                },
                ...(filename ? { title: filename } : {})
            };
        }

        if (this.isImageMimeType(mimeType)) {
            return {
                type: "image",
                source: {
                    type: "base64",
                    media_type: mimeType,
                    data: stripDataUriPrefix(base64)
                }
            };
        }

        throw new Error(`Anthropic OCR only supports image and PDF inputs (received ${mimeType})`);
    }

    private extractText(message: any): string {
        return (message?.content ?? [])
            .filter((c: any) => c.type === "text")
            .map((c: any) => c.text)
            .join("");
    }

    private stripJsonFences(text: string): string {
        const trimmed = text.trim();
        if (trimmed.startsWith("```") && trimmed.endsWith("```")) {
            return trimmed.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
        }
        return trimmed;
    }

    private normalizeOptionalText(value: unknown): string | undefined {
        if (typeof value === "string") {
            const trimmed = value.trim();
            return trimmed.length > 0 ? trimmed : undefined;
        }
        if (typeof value === "number" || typeof value === "boolean") {
            return String(value);
        }
        if (Array.isArray(value)) {
            const parts = value.map((item) => this.normalizeOptionalText(item)).filter((item): item is string => Boolean(item));
            return parts.length > 0 ? parts.join("\n") : undefined;
        }
        if (value && typeof value === "object") {
            try {
                const serialized = JSON.stringify(value);
                return serialized && serialized !== "{}" && serialized !== "[]" ? serialized : undefined;
            } catch {
                return undefined;
            }
        }
        return undefined;
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

    private isImageMimeType(value?: string): boolean {
        return typeof value === "string" && value.startsWith("image/");
    }

    private isLikelyImagePath(value: string): boolean {
        const lower = value.toLowerCase();
        return lower.endsWith(".png") || lower.endsWith(".jpg") || lower.endsWith(".jpeg") || lower.endsWith(".gif") || lower.endsWith(".webp");
    }

    private basename(value: string): string {
        const parts = value.split(/[\\/]/);
        return parts[parts.length - 1] || "ocr-input";
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
