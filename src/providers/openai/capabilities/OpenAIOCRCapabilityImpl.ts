/**
 * @module providers/openai/capabilities/OpenAIOCRCapabilityImpl.ts
 * @description OpenAI OCR capability adapter.
 */
import OpenAI from "openai";
import {
    AIProvider,
    AIRequest,
    AIResponse,
    BaseProvider,
    buildMetadata,
    CapabilityKeys,
    ClientFileInputSource,
    ClientOCRRequest,
    ClientReferenceImage,
    ensureDataUri,
    extractDataUriMimeType,
    fileNameFromPath,
    inferMimeTypeFromFilename,
    isImageMimeType,
    isLikelyImagePath,
    isNodeReadableStream,
    isPdfMimeType,
    MultiModalExecutionContext,
    NormalizedOCRDocument,
    OCRCapability,
    OCRText,
    normalizeOCRTextValue,
    readFileToBuffer,
    readNodeReadableStreamToUint8Array,
    resolveReferenceMediaUrl,
    toOpenAIUploadableFile
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
    /**
     * JSON schema used to constrain OpenAI OCR tool output.
     *
     * This adapter routes OCR through the Responses API and normalizes the tool
     * payload into `NormalizedOCRDocument`.
     *
     * Practical format support is intentionally left to the provider. Local
     * playground validation in this repo has been strongest for PDF plus common
     * image/document inputs, while some less common image formats such as BMP and
     * TIFF have failed provider-side.
     */
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
                            anyOf: [
                                { type: "object", additionalProperties: true },
                                { type: "array", items: {} }
                            ]
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

    /**
     * Creates a new OpenAI OCR capability adapter.
     *
     * @param {BaseProvider} provider Owning provider instance used for initialization checks and merged config access.
     * @param {OpenAI} client Initialized OpenAI SDK client.
     */
    constructor(
        private readonly provider: BaseProvider,
        private readonly client: OpenAI
    ) {}

    /**
     * Executes OCR through the OpenAI Responses API.
     *
     * Responsibilities:
     * - validate the OCR input shape
     * - resolve merged model/runtime options
     * - build multimodal Responses API content from images or file input
     * - parse structured tool output when available
     * - normalize parsed or fallback text into `NormalizedOCRDocument`
     *
     * @param {AIRequest<ClientOCRRequest>} request Unified OCR request envelope.
     * @param {MultiModalExecutionContext} _ctx Optional execution context. Unused directly in this adapter.
     * @param {AbortSignal} [signal] Optional cancellation signal.
     * @returns {Promise<AIResponse<NormalizedOCRDocument[]>>} Provider-normalized OCR artifacts.
     * @throws {Error} When input is invalid or the request is aborted before execution.
     */
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
        let salvageLanguage: string | undefined;
        for (const item of response.output ?? []) {
            if (item.type !== "function_call" || item.name !== "ocr_extract") {
                continue;
            }
            try {
                parsed = JSON.parse(item.arguments) as OpenAIOCRPayload;
                if (this.isDegenerateParsedPayload(parsed)) {
                    salvageLanguage = normalizeOCRTextValue(parsed.language) ?? salvageLanguage;
                    parsed = undefined;
                    continue;
                }
                break;
            } catch {
                // ignore invalid tool payloads and fall back to response output text
            }
        }
        if (!parsed && salvageLanguage) {
            parsed = { language: salvageLanguage };
        }

        const responseId = response.id ?? context?.requestId ?? crypto.randomUUID();
        const responseText = this.extractOutputText(response);
        const document = this.normalizeDocument(input, parsed, responseText, responseId);

        return {
            output: [document],
            multimodalArtifacts: { ocr: [document] },
            rawResponse: response,
            id: responseId,
            metadata: buildMetadata(context?.metadata, {
                provider: AIProvider.OpenAI,
                model: merged.model,
                status: response?.status ?? "completed",
                requestId: context?.requestId
            })
        };
    }

    /**
     * Ensures the request contains exactly one OCR source mode.
     *
     * @param {ClientOCRRequest} input OCR request input.
     * @throws {Error} When neither source type is provided or both file and images are supplied together.
     */
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

    /**
     * Builds the Responses API multimodal content array for OCR execution.
     *
     * @param {ClientOCRRequest} input OCR request input.
     * @returns {Promise<any[]>} OpenAI Responses API content parts for the OCR request.
     */
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

    /**
     * Builds the OCR extraction prompt sent alongside the file or image input.
     *
     * @param {ClientOCRRequest} input OCR request input.
     * @returns {string} Provider instruction text for OCR extraction.
     */
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

    /**
     * Normalizes parsed OCR payload and fallback output text into a unified OCR document.
     *
     * @param {ClientOCRRequest} input Original OCR request input.
     * @param {OpenAIOCRPayload | undefined} parsed Parsed structured OCR payload when available.
     * @param {string} rawText Fallback plain-text OCR output extracted from the response.
     * @param {string} responseId Stable response identifier for the normalized artifact.
     * @returns {NormalizedOCRDocument} Provider-normalized OCR document.
     */
    private normalizeDocument(
        input: ClientOCRRequest,
        parsed: OpenAIOCRPayload | undefined,
        rawText: string,
        responseId: string
    ): NormalizedOCRDocument {
        const normalizedParsedFullText = normalizeOCRTextValue(parsed?.fullText);
        const pages = parsed?.pages
            ?.map((page, index) => ({
                pageNumber: page.pageNumber ?? index + 1,
                fullText: normalizeOCRTextValue(page.fullText),
                text: normalizeOCRTextValue(page.fullText)
                    ? ([{ text: normalizeOCRTextValue(page.fullText)! }] satisfies OCRText[])
                    : undefined
            }))
            .filter((page) => page.fullText || page.text);

        const pageTexts = pages?.map((page) => page.fullText).filter((value): value is string => Boolean(value)) ?? [];
        const fullText = normalizedParsedFullText || pageTexts.join("\n\n").trim() || rawText.trim() || undefined;

        return {
            id: responseId,
            fullText,
            text: fullText ? [{ text: fullText }] : undefined,
            pages,
            language: normalizeOCRTextValue(parsed?.language) ?? input.language,
            pageCount: pages?.length,
            fileName: input.filename,
            mimeType: input.mimeType,
            sourceImageId: input.images?.[0]?.id,
            annotations: parsed?.annotations
                ?.filter((annotation) => annotation && (annotation.text || annotation.data))
                .map((annotation) => ({
                    type: annotation.type === "bbox" ? "bbox" : "document",
                    ...(annotation.label ? { label: annotation.label } : {}),
                    ...(normalizeOCRTextValue(annotation.text) ? { text: normalizeOCRTextValue(annotation.text) } : {}),
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
            metadata: buildMetadata(undefined, {
                provider: AIProvider.OpenAI,
                status: "completed",
                rawParsed: parsed
            })
        };
    }

    private isDegenerateParsedPayload(parsed: OpenAIOCRPayload | undefined): boolean {
        if (!parsed) {
            return true;
        }

        const fullText = normalizeOCRTextValue(parsed.fullText);
        const headers = parsed.headers?.some((section) => normalizeOCRTextValue(section?.text)) ?? false;
        const footers = parsed.footers?.some((section) => normalizeOCRTextValue(section?.text)) ?? false;
        const pages = parsed.pages?.some((page) => normalizeOCRTextValue(page?.fullText)) ?? false;
        const annotations =
            parsed.annotations?.some(
                (annotation) => normalizeOCRTextValue(annotation?.text) || annotation?.data !== undefined
            ) ?? false;

        if (fullText && fullText !== "true" && fullText !== "false") {
            return false;
        }

        return !(headers || footers || pages || annotations);
    }

    private toOpenAIImagePart(image: ClientReferenceImage) {
        return {
            type: "input_image",
            image_url: resolveReferenceMediaUrl(image, "image/png", "OpenAI OCR image inputs require image.url or image.base64")
        };
    }

    private async toOpenAISourcePart(file: ClientFileInputSource, mimeType?: string, filename?: string) {
        const resolvedMimeType = mimeType ?? inferMimeTypeFromFilename(filename) ?? "application/octet-stream";

        if (typeof file === "string") {
            if (/^https?:\/\//i.test(file)) {
                if (isImageMimeType(resolvedMimeType) || isLikelyImagePath(file)) {
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
                const dataUriMimeType = extractDataUriMimeType(file) ?? resolvedMimeType;
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

            const bytes = await readFileToBuffer(file);
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
                    filename: filename ?? fileNameFromPath(file, "ocr-input")
                });
            }
            return await this.uploadFileBackedInputPart({
                source: bytes,
                mimeType: inferredMimeType,
                filename: filename ?? fileNameFromPath(file, "ocr-input")
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

        if (isNodeReadableStream(file)) {
            const bytes = await readNodeReadableStreamToUint8Array(file);
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
        const uploadableFile = await toOpenAIUploadableFile(params.source, params.filename, params.mimeType, "ocr-input");
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
}
