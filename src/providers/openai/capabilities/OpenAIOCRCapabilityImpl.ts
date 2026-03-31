/**
 * @module providers/openai/capabilities/OpenAIOCRCapabilityImpl.ts
 * @description Provider implementations and capability adapters.
 */
import { access, readFile } from "node:fs/promises";
import OpenAI from "openai";
import { toFile } from "openai/uploads";
import {
    AIProvider,
    AIRequest,
    AIResponse,
    BaseProvider,
    CapabilityKeys,
    ClientFileInputSource,
    ClientOCRRequest,
    ClientReferenceImage,
    ensureDataUri,
    inferMimeTypeFromFilename,
    MultiModalExecutionContext,
    NormalizedOCRDocument,
    OCRCapability,
    OCRText,
    parseDataUriToBuffer
} from "#root/index.js";

const DEFAULT_OPENAI_OCR_MODEL = "gpt-4.1";

type OpenAIOCRPayload = {
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

export class OpenAIOCRCapabilityImpl implements OCRCapability<ClientOCRRequest, NormalizedOCRDocument[]> {
    static OPENAI_OCR_SCHEMA = {
        type: "object",
        additionalProperties: false,
        properties: {
            fullText: { type: "string" },
            language: { type: "string" },
            pages: {
                type: "array",
                items: {
                    type: "object",
                    additionalProperties: false,
                    properties: {
                        pageNumber: { type: "number" },
                        fullText: { type: "string" }
                    },
                    required: []
                }
            },
            headers: {
                type: "array",
                items: {
                    type: "object",
                    additionalProperties: false,
                    properties: {
                        pageNumber: { type: "number" },
                        text: { type: "string" }
                    },
                    required: []
                }
            },
            footers: {
                type: "array",
                items: {
                    type: "object",
                    additionalProperties: false,
                    properties: {
                        pageNumber: { type: "number" },
                        text: { type: "string" }
                    },
                    required: []
                }
            },
            annotations: {
                type: "array",
                items: {
                    type: "object",
                    additionalProperties: false,
                    properties: {
                        type: { type: "string", enum: ["document", "bbox"] },
                        label: { type: "string" },
                        text: { type: "string" },
                        data: {
                            anyOf: [{ type: "object", additionalProperties: true }, { type: "array", items: {} }]
                        },
                        pageNumber: { type: "number" }
                    },
                    required: []
                }
            }
        },
        required: []
    };

    static OPENAI_OCR_TOOL = {
        type: "function",
        name: "ocr_extract",
        description: "Extract OCR/document text and structured document details from the supplied image or file",
        parameters: OpenAIOCRCapabilityImpl.OPENAI_OCR_SCHEMA
    };

    private static readonly OCR_TOOLS = [OpenAIOCRCapabilityImpl.OPENAI_OCR_TOOL] as const;
    private static readonly OCR_TOOL_CHOICE = {
        type: "function" as const,
        name: "ocr_extract"
    };

    constructor(
        private readonly provider: BaseProvider,
        private readonly client: OpenAI
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
        const content = await this.buildContent(input);

        const response = await this.client.responses.create(
            {
                model: merged.model ?? DEFAULT_OPENAI_OCR_MODEL,
                input: [{ role: "user", content }],
                tools: OpenAIOCRCapabilityImpl.OCR_TOOLS as any,
                tool_choice: OpenAIOCRCapabilityImpl.OCR_TOOL_CHOICE,
                ...(merged.modelParams ?? {}),
                ...(merged.providerParams ?? {})
            },
            { signal }
        );

        let parsed: OpenAIOCRPayload | undefined;
        for (const item of response.output ?? []) {
            if (item.type !== "function_call" || item.name !== "ocr_extract") {
                continue;
            }
            try {
                parsed = JSON.parse(item.arguments) as OpenAIOCRPayload;
                if (this.isDegenerateParsedPayload(parsed)) {
                    const parsedLanguage = this.normalizeOptionalText(parsed.language);
                    parsed = parsedLanguage ? { language: parsedLanguage } : undefined;
                    continue;
                }
                break;
            } catch {
                // ignore invalid tool payloads and fall back to response output text
            }
        }

        const responseId = response.id ?? context?.requestId ?? crypto.randomUUID();
        const responseText = this.extractOutputText(response);
        const document = this.normalizeDocument(input, parsed, responseText, responseId);

        return {
            output: [document],
            multimodalArtifacts: { ocr: [document] },
            rawResponse: response,
            id: responseId,
            metadata: {
                ...(context?.metadata ?? {}),
                provider: AIProvider.OpenAI,
                model: merged.model,
                status: response?.status ?? "completed",
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
            throw new Error("OpenAI OCR accepts either `file` or `images`, not both");
        }
    }

    private async buildContent(input: ClientOCRRequest): Promise<any[]> {
        const content: any[] = [{ type: "input_text", text: this.buildOCRPrompt(input) }];

        if (input.images?.length) {
            for (const image of input.images) {
                content.push(this.toOpenAIImagePart(image));
            }
        } else if (input.file !== undefined) {
            content.push(await this.toOpenAISourcePart(input.file, input.mimeType, input.filename));
        }

        return content;
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
            "Extract readable document text and return ONLY valid JSON using the provided function schema.",
            "Preserve headings and bullet lists where possible.",
            "For screenshots, slides, and documents with visible text, populate fullText with the extracted readable text.",
            "Never use booleans, null, or placeholder values for text fields. Text fields must be strings or omitted.",
            "If structured extraction was requested, populate annotations accordingly.",
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
            instructions.push("Extract headers when visible.");
        }
        if (input.structured?.extractFooters) {
            instructions.push("Extract footers when visible.");
        }
        if (input.structured?.tableFormat) {
            instructions.push(`Represent tables using ${input.structured.tableFormat} when present.`);
        }

        return instructions.join("\n\n");
    }

    private normalizeDocument(
        input: ClientOCRRequest,
        parsed: OpenAIOCRPayload | undefined,
        rawText: string,
        responseId: string
    ): NormalizedOCRDocument {
        const normalizedParsedFullText = this.normalizeOptionalText(parsed?.fullText);
        const pages = parsed?.pages
            ?.map((page, index) => ({
                pageNumber: page.pageNumber ?? index + 1,
                fullText: this.normalizeOptionalText(page.fullText),
                text: this.normalizeOptionalText(page.fullText)
                    ? ([{ text: this.normalizeOptionalText(page.fullText)! }] satisfies OCRText[])
                    : undefined
            }))
            .filter((page) => page.fullText || page.text);

        const pageTexts = pages?.map((page) => page.fullText).filter((value): value is string => Boolean(value)) ?? [];
        const fullText = (normalizedParsedFullText || pageTexts.join("\n\n").trim() || rawText.trim()) || undefined;

        return {
            id: responseId,
            fullText,
            text: fullText ? [{ text: fullText }] : undefined,
            pages,
            language: this.normalizeOptionalText(parsed?.language) ?? input.language,
            pageCount: pages?.length,
            fileName: input.filename,
            mimeType: input.mimeType,
            sourceImageId: input.images?.[0]?.id,
            annotations: parsed?.annotations
                ?.filter((annotation) => annotation && (annotation.text || annotation.data))
                .map((annotation) => ({
                    type: annotation.type === "bbox" ? "bbox" : "document",
                    ...(annotation.label ? { label: annotation.label } : {}),
                    ...(this.normalizeOptionalText(annotation.text) ? { text: this.normalizeOptionalText(annotation.text) } : {}),
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
                provider: AIProvider.OpenAI,
                status: "completed",
                rawParsed: parsed
            }
        };
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
            const parts = value
                .map((item) => this.normalizeOptionalText(item))
                .filter((item): item is string => Boolean(item));
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

    private isDegenerateParsedPayload(parsed: OpenAIOCRPayload | undefined): boolean {
        if (!parsed) {
            return true;
        }

        const fullText = this.normalizeOptionalText(parsed.fullText);
        const headers = parsed.headers?.some((section) => this.normalizeOptionalText(section?.text)) ?? false;
        const footers = parsed.footers?.some((section) => this.normalizeOptionalText(section?.text)) ?? false;
        const pages =
            parsed.pages?.some((page) => this.normalizeOptionalText(page?.fullText)) ?? false;
        const annotations =
            parsed.annotations?.some(
                (annotation) => this.normalizeOptionalText(annotation?.text) || annotation?.data !== undefined
            ) ?? false;

        if (fullText && fullText !== "true" && fullText !== "false") {
            return false;
        }

        return !(headers || footers || pages || annotations);
    }

    private toOpenAIImagePart(image: ClientReferenceImage) {
        if (image.url) {
            return { type: "input_image", image_url: image.url };
        }
        if (image.base64) {
            return { type: "input_image", image_url: ensureDataUri(image.base64, image.mimeType) };
        }
        throw new Error("OpenAI OCR image inputs require image.url or image.base64");
    }

    private async toOpenAISourcePart(file: ClientFileInputSource, mimeType?: string, filename?: string) {
        const resolvedMimeType = mimeType ?? inferMimeTypeFromFilename(filename) ?? "application/octet-stream";
        const isImageMimeType = (value?: string) => typeof value === "string" && value.startsWith("image/");
        const isPdfMimeType = (value?: string) => value === "application/pdf";

        if (typeof file === "string") {
            if (/^https?:\/\//i.test(file)) {
                if (isImageMimeType(resolvedMimeType) || this.isLikelyImagePath(file)) {
                    return {
                        type: "input_image",
                        image_url: file
                    };
                }
                return {
                    type: "input_file",
                    file_url: file
                };
            }

            if (/^data:/i.test(file)) {
                const dataUriMimeType = this.mimeTypeFromDataUri(file) ?? resolvedMimeType;
                if (isImageMimeType(dataUriMimeType)) {
                    return {
                        type: "input_image",
                        image_url: file
                    };
                }
                if (isPdfMimeType(dataUriMimeType)) {
                    return await this.uploadFileBackedInputPart({
                        source: file,
                        mimeType: dataUriMimeType,
                        filename: filename ?? "ocr-input.pdf"
                    });
                }
                return await this.uploadFileBackedInputPart({
                    source: file,
                    mimeType: dataUriMimeType,
                    filename: filename ?? "ocr-input"
                });
            }

            await access(file);
            const bytes = await readFile(file);
            const inferredMimeType = mimeType ?? inferMimeTypeFromFilename(file) ?? resolvedMimeType;
            const dataUri = ensureDataUri(Buffer.from(bytes).toString("base64"), inferredMimeType);
            if (isImageMimeType(inferredMimeType)) {
                return {
                    type: "input_image",
                    image_url: dataUri
                };
            }
            if (isPdfMimeType(inferredMimeType)) {
                return await this.uploadFileBackedInputPart({
                    source: bytes,
                    mimeType: inferredMimeType,
                    filename: filename ?? this.basename(file)
                });
            }
            return await this.uploadFileBackedInputPart({
                source: bytes,
                mimeType: inferredMimeType,
                filename: filename ?? this.basename(file)
            });
        }

        if (typeof Blob !== "undefined" && file instanceof Blob) {
            const buffer = Buffer.from(await file.arrayBuffer());
            const blobMimeType = file.type || resolvedMimeType;
            const dataUri = ensureDataUri(buffer.toString("base64"), blobMimeType);
            if (isImageMimeType(blobMimeType)) {
                return {
                    type: "input_image",
                    image_url: dataUri
                };
            }
            if (isPdfMimeType(blobMimeType)) {
                return await this.uploadFileBackedInputPart({
                    source: buffer,
                    mimeType: blobMimeType,
                    filename: filename ?? "ocr-input.pdf"
                });
            }
            return await this.uploadFileBackedInputPart({
                source: buffer,
                mimeType: blobMimeType,
                filename: filename ?? "ocr-input"
            });
        }

        if (typeof Buffer !== "undefined" && Buffer.isBuffer(file)) {
            const dataUri = ensureDataUri(Buffer.from(file).toString("base64"), resolvedMimeType);
            if (isImageMimeType(resolvedMimeType)) {
                return {
                    type: "input_image",
                    image_url: dataUri
                };
            }
            if (isPdfMimeType(resolvedMimeType)) {
                return await this.uploadFileBackedInputPart({
                    source: file,
                    mimeType: resolvedMimeType,
                    filename: filename ?? "ocr-input.pdf"
                });
            }
            return await this.uploadFileBackedInputPart({
                source: file,
                mimeType: resolvedMimeType,
                filename: filename ?? "ocr-input"
            });
        }

        if (file instanceof Uint8Array) {
            const dataUri = ensureDataUri(Buffer.from(file).toString("base64"), resolvedMimeType);
            if (isImageMimeType(resolvedMimeType)) {
                return {
                    type: "input_image",
                    image_url: dataUri
                };
            }
            if (isPdfMimeType(resolvedMimeType)) {
                return await this.uploadFileBackedInputPart({
                    source: file,
                    mimeType: resolvedMimeType,
                    filename: filename ?? "ocr-input.pdf"
                });
            }
            return await this.uploadFileBackedInputPart({
                source: file,
                mimeType: resolvedMimeType,
                filename: filename ?? "ocr-input"
            });
        }

        if (file instanceof ArrayBuffer) {
            const dataUri = ensureDataUri(Buffer.from(file).toString("base64"), resolvedMimeType);
            if (isImageMimeType(resolvedMimeType)) {
                return {
                    type: "input_image",
                    image_url: dataUri
                };
            }
            if (isPdfMimeType(resolvedMimeType)) {
                return await this.uploadFileBackedInputPart({
                    source: file,
                    mimeType: resolvedMimeType,
                    filename: filename ?? "ocr-input.pdf"
                });
            }
            return await this.uploadFileBackedInputPart({
                source: file,
                mimeType: resolvedMimeType,
                filename: filename ?? "ocr-input"
            });
        }

        if (this.isNodeReadableStream(file)) {
            const bytes = await this.readNodeStream(file, undefined);
            const dataUri = ensureDataUri(Buffer.from(bytes).toString("base64"), resolvedMimeType);
            if (isImageMimeType(resolvedMimeType)) {
                return {
                    type: "input_image",
                    image_url: dataUri
                };
            }
            if (isPdfMimeType(resolvedMimeType)) {
                return await this.uploadFileBackedInputPart({
                    source: bytes,
                    mimeType: resolvedMimeType,
                    filename: filename ?? "ocr-input.pdf"
                });
            }
            return await this.uploadFileBackedInputPart({
                source: bytes,
                mimeType: resolvedMimeType,
                filename: filename ?? "ocr-input"
            });
        }

        throw new Error("Unsupported OpenAI OCR input type");
    }

    private async uploadFileBackedInputPart(params: {
        source: ClientFileInputSource;
        mimeType: string;
        filename: string;
    }): Promise<{ type: "input_file"; file_id: string }> {
        const uploadableFile = await this.toUploadableFile(params.source, params.filename, params.mimeType);
        const uploadedFile = await this.client.files.create({
            file: uploadableFile as any,
            purpose: "user_data"
        });

        return {
            type: "input_file",
            file_id: uploadedFile.id
        };
    }

    private extractOutputText(response: OpenAI.Responses.Response): string {
        const texts = new Array<string>();
        for (const item of response.output ?? []) {
            if (item.type !== "message") {
                continue;
            }
            for (const content of item.content ?? []) {
                if (content.type === "output_text" && typeof content.text === "string" && content.text.trim().length > 0) {
                    texts.push(content.text.trim());
                }
            }
        }
        return texts.join("\n").trim();
    }

    private isLikelyImagePath(value: string): boolean {
        const lower = value.toLowerCase();
        return lower.endsWith(".png") || lower.endsWith(".jpg") || lower.endsWith(".jpeg") || lower.endsWith(".webp");
    }

    private mimeTypeFromDataUri(value: string): string | undefined {
        const match = /^data:([^;,]+)[;,]/i.exec(value);
        return match?.[1];
    }

    private async toUploadableFile(source: ClientFileInputSource, filename: string, mimeType: string) {
        if (this.isBlobLike(source)) {
            return await toFile(source as any, filename, { type: mimeType });
        }

        if (Buffer.isBuffer(source)) {
            return await toFile(source, filename, { type: mimeType });
        }

        if (source instanceof Uint8Array) {
            return await toFile(Buffer.from(source), filename, { type: mimeType });
        }

        if (source instanceof ArrayBuffer) {
            return await toFile(Buffer.from(source), filename, { type: mimeType });
        }

        if (typeof source === "string") {
            if (source.startsWith("data:")) {
                const parsed = parseDataUriToBuffer(source);
                return await toFile(parsed.bytes, filename, { type: mimeType || parsed.mimeType });
            }

            if (await this.pathExists(source)) {
                const bytes = await readFile(source);
                return await toFile(bytes, filename, { type: mimeType });
            }
        }

        return await toFile(source as any, filename, { type: mimeType });
    }

    private isBlobLike(value: unknown): boolean {
        if (!value || typeof value !== "object") {
            return false;
        }
        return typeof (value as any).arrayBuffer === "function" && typeof (value as any).type === "string";
    }

    private async pathExists(path: string): Promise<boolean> {
        try {
            await access(path);
            return true;
        } catch {
            return false;
        }
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
