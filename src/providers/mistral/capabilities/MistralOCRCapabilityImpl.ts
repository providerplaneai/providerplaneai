/**
 * @module providers/mistral/capabilities/MistralOCRCapabilityImpl.ts
 * @description Mistral OCR capability adapter.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { Mistral } from "@mistralai/mistralai";
import type { FileT, OCRRequest, OCRResponse, OCRPageObject } from "@mistralai/mistralai/models/components";
import {
    AIProvider,
    AIRequest,
    AIResponse,
    BaseProvider,
    BoundingBox,
    CapabilityKeys,
    ClientFileInputSource,
    ClientOCRRequest,
    ClientReferenceImage,
    dataUriToUint8Array,
    MultiModalExecutionContext,
    NormalizedOCRDocument,
    OCRCapability,
    OCRText,
    ensureDataUri
} from "#root/index.js";

const DEFAULT_MISTRAL_OCR_MODEL = "mistral-ocr-latest";
const DEFAULT_OCR_FILENAME = "ocr-input";

type MistralOCRFormatSupportLevel = "documented" | "tested" | "experimental";
type MistralOCRTransportClass = "image" | "document";

type MistralOCRFormatDescriptor = {
    extension: string;
    mimeType: string;
    transport: MistralOCRTransportClass;
    supportLevel: MistralOCRFormatSupportLevel;
};

export const MISTRAL_OCR_FORMATS = {
    tested: [
        { extension: "png", mimeType: "image/png", transport: "image", supportLevel: "tested" },
        { extension: "jpg", mimeType: "image/jpeg", transport: "image", supportLevel: "tested" },
        { extension: "jpeg", mimeType: "image/jpeg", transport: "image", supportLevel: "tested" },
        { extension: "webp", mimeType: "image/webp", transport: "image", supportLevel: "tested" },
        { extension: "gif", mimeType: "image/gif", transport: "image", supportLevel: "tested" },
        { extension: "bmp", mimeType: "image/bmp", transport: "image", supportLevel: "tested" },
        { extension: "tiff", mimeType: "image/tiff", transport: "image", supportLevel: "tested" },
        { extension: "heic", mimeType: "image/heic", transport: "image", supportLevel: "tested" },
        { extension: "heif", mimeType: "image/heif", transport: "image", supportLevel: "tested" },
        { extension: "pdf", mimeType: "application/pdf", transport: "document", supportLevel: "tested" },
        {
            extension: "docx",
            mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            transport: "document",
            supportLevel: "tested"
        },
        {
            extension: "pptx",
            mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
            transport: "document",
            supportLevel: "tested"
        },
        { extension: "odt", mimeType: "application/vnd.oasis.opendocument.text", transport: "document", supportLevel: "tested" },
        {
            extension: "xlsx",
            mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            transport: "document",
            supportLevel: "tested"
        }
    ],
    documented: [{ extension: "avif", mimeType: "image/avif", transport: "image", supportLevel: "documented" }],
    experimental: [
        { extension: "jpe", mimeType: "image/jpeg", transport: "image", supportLevel: "experimental" },
        { extension: "jfif", mimeType: "image/jpeg", transport: "image", supportLevel: "experimental" },
        { extension: "tif", mimeType: "image/tiff", transport: "image", supportLevel: "experimental" },
        { extension: "rtf", mimeType: "application/rtf", transport: "document", supportLevel: "experimental" }
    ]
} as const satisfies Record<MistralOCRFormatSupportLevel, readonly MistralOCRFormatDescriptor[]>;

const MISTRAL_OCR_FORMAT_LIST = [
    ...MISTRAL_OCR_FORMATS.tested,
    ...MISTRAL_OCR_FORMATS.documented,
    ...MISTRAL_OCR_FORMATS.experimental
] as const satisfies readonly MistralOCRFormatDescriptor[];

const MISTRAL_OCR_EXTENSION_TO_FORMAT = new Map<string, MistralOCRFormatDescriptor>(
    MISTRAL_OCR_FORMAT_LIST.map((format) => [format.extension, format] satisfies [string, MistralOCRFormatDescriptor])
);
const MISTRAL_OCR_MIME_TO_FORMAT = new Map<string, MistralOCRFormatDescriptor>(
    MISTRAL_OCR_FORMAT_LIST.map((format) => [format.mimeType, format] satisfies [string, MistralOCRFormatDescriptor])
);

type MistralOCRDocumentInput =
    | { type: "image_url"; imageUrl: string }
    | { type: "document_url"; documentUrl: string; documentName?: string }
    | { type: "file"; fileId: string };

/**
 * Adapts Mistral's `/v1/ocr` endpoint into ProviderPlaneAI OCR document artifacts.
 *
 * Accepts exactly one OCR source per request, routes remote inputs as image or
 * document references when possible, uploads local or byte-backed inputs to
 * Mistral files when needed, and normalizes OCR page markdown into readable
 * document and page text output.
 *
 * @public
 * @description Provider capability implementation for MistralOCRCapabilityImpl.
 */
export class MistralOCRCapabilityImpl implements OCRCapability<ClientOCRRequest, NormalizedOCRDocument[]> {
    /**
     * Creates a new Mistral OCR capability adapter.
     *
     * @param {BaseProvider} provider Owning provider instance used for initialization checks and merged config access.
     * @param {Mistral} client Initialized official Mistral SDK client.
     */
    constructor(
        private readonly provider: BaseProvider,
        private readonly client: Mistral
    ) {}

    /**
     * Executes OCR against the Mistral OCR API.
     *
     * @param {AIRequest<ClientOCRRequest>} request Unified OCR request envelope.
     * @param {MultiModalExecutionContext} _ctx Optional execution context. Unused directly in this adapter.
     * @param {AbortSignal} [signal] Optional cancellation signal.
     * @throws {Error} When no OCR input is supplied, multiple OCR sources are supplied, or the request is aborted.
     * @returns {Promise<AIResponse<NormalizedOCRDocument[]>>} Provider-normalized OCR artifacts.
     */
    async ocr(
        request: AIRequest<ClientOCRRequest>,
        _ctx?: MultiModalExecutionContext,
        signal?: AbortSignal
    ): Promise<AIResponse<NormalizedOCRDocument[]>> {
        this.provider.ensureInitialized();

        if (signal?.aborted) {
            throw new Error("OCR request aborted before execution");
        }

        const { input, options, context } = request;
        // Mistral OCR currently accepts one source per request, so reject mixed or multi-image
        // inputs before building any provider-specific request payload.
        this.assertSingleSource(input);

        const merged = this.provider.getMergedOptions(CapabilityKeys.OCRCapabilityKey, options);
        const model = merged.model ?? DEFAULT_MISTRAL_OCR_MODEL;
        const document = await this.resolveDocumentInput(input, signal);
        const ocrRequest = this.buildOCRRequest(model, input, document, merged.modelParams);
        const response = await this.client.ocr.process(ocrRequest, {
            signal,
            ...(merged.providerParams ?? {})
        });

        const artifact = this.normalizeResponse(response, input, context?.requestId);

        return {
            output: [artifact],
            id: artifact.id,
            rawResponse: response,
            multimodalArtifacts: { ocr: [artifact] },
            metadata: {
                ...(context?.metadata ?? {}),
                provider: AIProvider.Mistral,
                model: response.model ?? model,
                status: "completed",
                requestId: context?.requestId,
                pagesProcessed: response.pages.length,
                documentPages: response.pages.length,
                ...(typeof response.usageInfo?.pagesProcessed === "number"
                    ? { pagesProcessed: response.usageInfo.pagesProcessed }
                    : {})
            }
        };
    }

    /**
     * Ensures the request carries exactly one OCR source.
     *
     * @param {ClientOCRRequest} input OCR request input.
     * @throws {Error} When no source or multiple sources are supplied.
     * @returns {void}
     */
    private assertSingleSource(input: ClientOCRRequest): void {
        const imageCount = input.images?.length ?? 0;
        const hasFile = input.file !== undefined;

        if (!hasFile && imageCount === 0) {
            throw new Error("OCR requires either `file` or one image");
        }

        if (hasFile && imageCount > 0) {
            throw new Error("Mistral OCR accepts one source per request: provide either `file` or `images`, not both");
        }

        if (imageCount > 1) {
            throw new Error("Mistral OCR currently supports exactly one image per request");
        }
    }

    /**
     * Builds a typed Mistral OCR request.
     *
     * @param {string} model Resolved model name.
     * @param {ClientOCRRequest} input Original OCR input.
     * @param {MistralOCRDocumentInput} document Resolved Mistral OCR document input.
     * @param {Record<string, unknown> | undefined} modelParams Provider/model-specific overrides.
     * @returns {OCRRequest} SDK-compatible OCR request.
     */
    private buildOCRRequest(
        model: string,
        input: ClientOCRRequest,
        document: MistralOCRDocumentInput,
        modelParams?: Record<string, unknown>
    ): OCRRequest {
        const structured = input.structured;
        const documentAnnotationFormat = this.extractDocumentAnnotationFormat(structured, modelParams);
        const bboxAnnotationFormat = this.extractBBoxAnnotationFormat(structured, modelParams);
        const tableFormat = this.extractTableFormat(structured, modelParams);
        const annotationPrompt = structured?.annotationPrompt ?? input.prompt;

        return {
            model,
            document,
            ...(bboxAnnotationFormat ? { bboxAnnotationFormat } : {}),
            ...(documentAnnotationFormat ? { documentAnnotationFormat } : {}),
            ...(annotationPrompt && documentAnnotationFormat ? { documentAnnotationPrompt: annotationPrompt } : {}),
            ...(tableFormat !== undefined ? { tableFormat } : {}),
            ...(structured?.pages?.length ? { pages: structured.pages.map((page) => Math.max(0, page - 1)) } : {}),
            ...(structured?.extractHeaders ? { extractHeader: true } : {}),
            ...(structured?.extractFooters ? { extractFooter: true } : {}),
            ...(input.includeBoundingBoxes ? { includeImageBase64: true } : {}),
            ...(modelParams ?? {})
        } as OCRRequest;
    }

    /**
     * Extracts a Mistral document annotation format from provider/model params when present.
     *
     * Mistral only accepts `documentAnnotationPrompt` when a matching
     * `documentAnnotationFormat` is also supplied. Generic OCR prompts should therefore
     * be ignored unless the caller explicitly opts into Mistral's structured annotation mode.
     *
     * @param {Record<string, unknown> | undefined} modelParams Provider/model-specific overrides.
     * @returns {OCRRequest["documentAnnotationFormat"] | undefined} Valid document annotation format when present.
     */
    private extractDocumentAnnotationFormat(
        structured?: ClientOCRRequest["structured"],
        modelParams?: Record<string, unknown>
    ): OCRRequest["documentAnnotationFormat"] | undefined {
        const annotationMode = this.getAnnotationMode(structured);
        if (annotationMode === "document") {
            const annotationSchema = structured?.annotationSchema;
            if (!annotationSchema) {
                throw new Error("Mistral OCR document annotations require structured.annotationSchema");
            }

            return {
                type: "json_schema",
                jsonSchema: {
                    name: annotationSchema.name,
                    ...(annotationSchema.description
                        ? { description: annotationSchema.description }
                        : {}),
                    schemaDefinition: annotationSchema.schema,
                    ...(annotationSchema.strict !== undefined
                        ? { strict: annotationSchema.strict }
                        : {})
                }
            } as OCRRequest["documentAnnotationFormat"];
        }

        const value = modelParams?.documentAnnotationFormat;
        return typeof value === "object" && value !== null ? (value as OCRRequest["documentAnnotationFormat"]) : undefined;
    }

    /**
     * Extracts a Mistral bbox annotation format from request/model params when present.
     *
     * @param {ClientOCRRequest["structured"] | undefined} structured OCR structured extraction options supplied by the caller.
     * @param {Record<string, unknown> | undefined} modelParams Provider/model-specific overrides.
     * @returns {OCRRequest["bboxAnnotationFormat"] | undefined} Valid bbox annotation format when present.
     */
    private extractBBoxAnnotationFormat(
        structured?: ClientOCRRequest["structured"],
        modelParams?: Record<string, unknown>
    ): OCRRequest["bboxAnnotationFormat"] | undefined {
        const annotationMode = this.getAnnotationMode(structured);
        if (annotationMode === "regions") {
            const annotationSchema = structured?.annotationSchema;
            if (!annotationSchema) {
                throw new Error("Mistral OCR region annotations require structured.annotationSchema");
            }

            return {
                type: "json_schema",
                jsonSchema: {
                    name: annotationSchema.name,
                    ...(annotationSchema.description
                        ? { description: annotationSchema.description }
                        : {}),
                    schemaDefinition: annotationSchema.schema,
                    ...(annotationSchema.strict !== undefined
                        ? { strict: annotationSchema.strict }
                        : {})
                }
            } as OCRRequest["bboxAnnotationFormat"];
        }

        const value = modelParams?.bboxAnnotationFormat;
        return typeof value === "object" && value !== null ? (value as OCRRequest["bboxAnnotationFormat"]) : undefined;
    }

    /**
     * Resolves the provider-agnostic OCR annotation mode from the request.
     *
     * Supports the generic OCR `annotationMode` field.
     *
     * @param {ClientOCRRequest["structured"] | undefined} structured OCR structured extraction options supplied by the caller.
     * @returns {"document" | "regions" | undefined} Resolved annotation mode when requested.
     */
    private getAnnotationMode(structured?: ClientOCRRequest["structured"]): "document" | "regions" | undefined {
        return structured?.annotationMode;
    }

    /**
     * Extracts a Mistral table format from request/model params when present.
     *
     * @param {ClientOCRRequest["structured"] | undefined} structured OCR structured extraction options supplied by the caller.
     * @param {Record<string, unknown> | undefined} modelParams Provider/model-specific overrides.
     * @returns {OCRRequest["tableFormat"] | undefined} Valid table format when present.
     */
    private extractTableFormat(
        structured?: ClientOCRRequest["structured"],
        modelParams?: Record<string, unknown>
    ): OCRRequest["tableFormat"] | undefined {
        const value = structured?.tableFormat ?? modelParams?.tableFormat;
        if (value === "markdown" || value === "html") {
            return value;
        }
        if (value === "inline") {
            return null;
        }
        return undefined;
    }

    /**
     * Resolves the caller's OCR input into a Mistral OCR document input.
     *
     * @param {ClientOCRRequest} input OCR request input.
     * @param {AbortSignal} [signal] Optional cancellation signal.
     * @returns {Promise<MistralOCRDocumentInput>} SDK-compatible OCR document input.
     */
    private async resolveDocumentInput(
        input: ClientOCRRequest,
        signal?: AbortSignal
    ): Promise<MistralOCRDocumentInput> {
        const image = input.images?.[0];
        if (image) {
            return this.toImageChunk(image);
        }

        const file = input.file;
        if (file === undefined) {
            throw new Error("OCR requires a file or image input");
        }

        return this.toDocumentChunk(file, input.filename, input.mimeType, signal);
    }

    /**
     * Converts a reference image into Mistral's image OCR input shape.
     *
     * @param {ClientReferenceImage} image Single OCR image input.
     * @returns {MistralOCRDocumentInput} Image OCR request chunk.
     */
    private toImageChunk(image: ClientReferenceImage): MistralOCRDocumentInput {
        if (image.url) {
            return { type: "image_url", imageUrl: image.url };
        }

        if (image.base64) {
            return { type: "image_url", imageUrl: ensureDataUri(image.base64, image.mimeType) };
        }

        throw new Error("Mistral OCR image inputs require either `url` or `base64`");
    }

    /**
     * Converts a generic file input into either a remote document URL or an uploaded Mistral file reference.
     *
     * @param {ClientFileInputSource} file OCR file input source.
     * @param {string} [filename] Optional filename hint.
     * @param {string} [mimeType] Optional MIME type hint.
     * @param {AbortSignal} [signal] Optional cancellation signal.
     * @returns {Promise<MistralOCRDocumentInput>} File/document OCR request chunk.
     */
    private async toDocumentChunk(
        file: ClientFileInputSource,
        filename?: string,
        mimeType?: string,
        signal?: AbortSignal
    ): Promise<MistralOCRDocumentInput> {
        if (typeof file === "string") {
            const isRemoteUrl = /^https?:\/\//i.test(file);
            if (isRemoteUrl) {
                // Mistral OCR exposes different request fields for remote images vs remote
                // documents, so URL inputs must be classified before dispatch.
                if (this.looksLikeImageUrl(file, mimeType)) {
                    return { type: "image_url", imageUrl: file };
                }

                return {
                    type: "document_url",
                    documentUrl: file,
                    ...(filename ? { documentName: filename } : {})
                };
            }

            const isDataUri = /^data:/i.test(file);
            if (isDataUri) {
                const dataUriMimeType = this.extractDataUriMimeType(file) ?? mimeType;
                if (this.isImageMimeType(dataUriMimeType)) {
                    return { type: "image_url", imageUrl: file };
                }

                // Non-image data URIs need to be uploaded as OCR files because Mistral only
                // accepts inline data for image transport, not for document transport.
                const fileName = this.resolveUploadFilename(filename, dataUriMimeType);
                return this.uploadFile(
                    {
                        fileName,
                        content: dataUriToUint8Array(file)
                    },
                    signal
                );
            }

            const bytes = await readFile(file);
            if (signal?.aborted) {
                throw new Error("OCR request aborted while reading file input");
            }

            // Preserving a meaningful filename helps Mistral infer document type for uploaded
            // bytes, especially for formats like PDF, DOCX, PPTX, and XLSX.
            const uploadFileName = this.resolveUploadFilename(filename ?? path.basename(file), mimeType);
            const uploadContent =
                mimeType && typeof Blob !== "undefined"
                    ? new Blob([bytes], { type: mimeType })
                    : new Uint8Array(bytes);

            return this.uploadFile(
                {
                    fileName: uploadFileName,
                    content: uploadContent
                },
                signal
            );
        }

        const uploadFileName = this.resolveUploadFilename(filename, mimeType);

        if (typeof Blob !== "undefined" && file instanceof Blob) {
            return this.uploadFile(
                {
                    fileName: this.resolveUploadFilename(filename ?? this.extractBlobName(file), mimeType ?? file.type),
                    content: mimeType && !file.type ? new Blob([file], { type: mimeType }) : file
                },
                signal
            );
        }

        if (typeof Buffer !== "undefined" && Buffer.isBuffer(file)) {
            return this.uploadFile(
                {
                    fileName: uploadFileName,
                    content: new Uint8Array(file)
                },
                signal
            );
        }

        if (file instanceof Uint8Array) {
            return this.uploadFile(
                {
                    fileName: uploadFileName,
                    content: file
                },
                signal
            );
        }

        if (file instanceof ArrayBuffer) {
            return this.uploadFile(
                {
                    fileName: uploadFileName,
                    content: new Uint8Array(file)
                },
                signal
            );
        }

        if (this.isNodeReadableStream(file)) {
            const content = await this.readNodeStream(file, signal);
            return this.uploadFile(
                {
                    fileName: uploadFileName,
                    content
                },
                signal
            );
        }

        throw new Error("Unsupported Mistral OCR input type");
    }

    /**
     * Uploads a local OCR file to Mistral and returns a file-chunk reference.
     *
     * @param {FileT} file File payload to upload.
     * @param {AbortSignal} [signal] Optional cancellation signal.
     * @returns {Promise<MistralOCRDocumentInput>} Uploaded file OCR chunk.
     */
    private async uploadFile(file: FileT, signal?: AbortSignal): Promise<MistralOCRDocumentInput> {
        const response = await this.client.files.upload(
            {
                purpose: "ocr",
                file
            },
            { signal }
        );

        return {
            type: "file",
            fileId: response.id
        };
    }

    /**
     * Normalizes a Mistral OCR response into a ProviderPlaneAI OCR artifact.
     *
     * @param {OCRResponse} response Raw Mistral OCR response.
     * @param {ClientOCRRequest} input Original request input.
     * @param {string} [requestId] Optional request identifier.
     * @returns {NormalizedOCRDocument} Provider-normalized OCR artifact.
     */
    private normalizeResponse(
        response: OCRResponse,
        input: ClientOCRRequest,
        requestId?: string
    ): NormalizedOCRDocument {
        const pages = response.pages.map((page) => this.normalizePage(page));
        const pageTexts = pages
            .map((page) => page.fullText)
            .filter((value): value is string => typeof value === "string" && value.length > 0);
        const fullText = pageTexts.join("\n\n").trim();
        const rawDocumentMarkdown = response.pages.map((page) => page.markdown).filter(Boolean).join("\n\n").trim();
        const annotations = this.normalizeAnnotations(response);
        const tables = this.normalizeTables(response);
        const headers = this.normalizePageSections(response.pages, "header");
        const footers = this.normalizePageSections(response.pages, "footer");
        // Mistral's page markdown is the richest OCR text surface in the response, so readable
        // document text is derived from markdown normalization rather than from a separate
        // provider-supplied plain-text field.

        return {
            id: requestId ?? crypto.randomUUID(),
            fullText: fullText || undefined,
            text:
                pages.length === 1
                    ? pages[0]?.text
                    : pageTexts.map((text) => ({ text })) satisfies OCRText[],
            pages,
            language: input.language,
            pageCount: pages.length,
            fileName: input.filename,
            mimeType: input.mimeType,
            sourceImageId: input.images?.[0]?.id,
            annotations,
            tables,
            headers,
            footers,
            rawDocumentMarkdown: rawDocumentMarkdown || undefined,
            metadata: {
                provider: AIProvider.Mistral,
                model: response.model,
                status: "completed",
                pagesProcessed: response.usageInfo?.pagesProcessed
            }
        };
    }

    /**
     * Normalizes a single Mistral OCR page.
     *
     * @param {OCRPageObject} page Raw OCR page.
     * @returns {NormalizedOCRDocument["pages"][number]} Normalized OCR page.
     */
    private normalizePage(page: OCRPageObject): NonNullable<NormalizedOCRDocument["pages"]>[number] {
        const fullText = this.buildPageText(page).trim();
        const hyperlinks = this.resolvePageHyperlinks(page);
        const normalizedMarkdown = this.normalizeMarkdownTableOutput(page.markdown);

        return {
            pageNumber: page.index + 1,
            fullText: fullText || undefined,
            text: fullText ? [{ text: fullText }] : undefined,
            metadata: {
                markdown: normalizedMarkdown || undefined,
                header: page.header,
                footer: page.footer,
                hyperlinks,
                dimensions: page.dimensions,
                imageCount: page.images.length,
                tableCount: page.tables?.length ?? 0
            }
        };
    }

    /**
     * Normalizes structured OCR annotations from document- and image-level fields.
     *
     * @param {OCRResponse} response Raw Mistral OCR response.
     * @returns {NormalizedOCRDocument["annotations"]} Structured normalized annotations.
     */
    private normalizeAnnotations(response: OCRResponse): NormalizedOCRDocument["annotations"] {
        const annotations: NonNullable<NormalizedOCRDocument["annotations"]> = [];

        if (typeof response.documentAnnotation === "string" && response.documentAnnotation.trim().length > 0) {
            const text = response.documentAnnotation.trim();
            annotations.push({
                type: "document",
                text,
                data: this.tryParseAnnotationJson(text)
            });
        }

        response.pages.forEach((page, pageIndex) => {
            for (const image of page.images ?? []) {
                if (typeof image.imageAnnotation !== "string" || image.imageAnnotation.trim().length === 0) {
                    continue;
                }

                annotations.push({
                    type: "bbox",
                    text: image.imageAnnotation.trim(),
                    pageNumber: pageIndex + 1,
                    bbox: this.toBoundingBox(image.topLeftX, image.topLeftY, image.bottomRightX, image.bottomRightY),
                    metadata: {
                        imageId: image.id
                    }
                });
            }
        });

        return annotations.length ? annotations : undefined;
    }

    /**
     * Parses a structured annotation payload when the provider emits valid JSON.
     *
     * Raw text is preserved separately so parsing failures do not lose information.
     *
     * @param {string} value Raw annotation payload.
     * @returns {Record<string, unknown> | unknown[] | undefined} Parsed JSON object/array when valid.
     */
    private tryParseAnnotationJson(value: string): Record<string, unknown> | unknown[] | undefined {
        try {
            const parsed = JSON.parse(value) as unknown;
            if (Array.isArray(parsed)) {
                return parsed;
            }
            if (parsed && typeof parsed === "object") {
                return parsed as Record<string, unknown>;
            }
            return undefined;
        } catch {
            return undefined;
        }
    }

    /**
     * Normalizes extracted OCR tables into a provider-agnostic shape.
     *
     * @param {OCRResponse} response Raw Mistral OCR response.
     * @returns {NormalizedOCRDocument["tables"]} Structured normalized tables.
     */
    private normalizeTables(response: OCRResponse): NormalizedOCRDocument["tables"] {
        const tables = response.pages.flatMap((page, pageIndex) =>
            (page.tables ?? [])
                .filter(
                    (table) =>
                        typeof table.content === "string" &&
                        table.content.trim().length > 0 &&
                        (table.format === "markdown" || table.format === "html")
                )
                .map((table) => ({
                    pageNumber: pageIndex + 1,
                    format: table.format as "markdown" | "html",
                    content: table.format === "markdown" ? this.normalizeMarkdownTableOutput(table.content) : table.content.trim()
                }))
        );

        return tables.length ? tables : undefined;
    }

    /**
     * Normalizes optional page headers or footers from the OCR payload.
     *
     * @param {OCRPageObject[]} pages Raw OCR pages.
     * @param {"header" | "footer"} key Page section key to extract.
     * @returns {NormalizedOCRDocument["headers"] | NormalizedOCRDocument["footers"]} Normalized page sections.
     */
    private normalizePageSections(
        pages: OCRPageObject[],
        key: "header" | "footer"
    ): NormalizedOCRDocument["headers"] | NormalizedOCRDocument["footers"] {
        const sections = pages
            .map((page, pageIndex) => {
                const text = typeof page[key] === "string" ? page[key].trim() : "";
                if (!text) {
                    return undefined;
                }

                return {
                    pageNumber: pageIndex + 1,
                    text
                };
            })
            .filter((value): value is { pageNumber: number; text: string } => Boolean(value));

        return sections.length ? sections : undefined;
    }

    /**
     * Builds a plain-text page representation from the OCR page payload.
     *
     * @param {OCRPageObject} page Raw OCR page.
     * @returns {string} Plain-text page content.
     */
    private buildPageText(page: OCRPageObject): string {
        const parts = [page.header, this.extractReadableTextFromMarkdown(this.normalizeMarkdownTableOutput(page.markdown)), page.footer]
            .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
            .map((value) => value.trim());

        return parts.join("\n").trim();
    }

    /**
     * Removes trailing empty markdown table rows that frequently appear in
     * spreadsheet-derived OCR output while preserving meaningful markdown content.
     *
     * Raw provider markdown remains preserved separately in `rawDocumentMarkdown`.
     *
     * @param {string | null | undefined} markdown Raw markdown content from a page or table.
     * @returns {string} Cleaned markdown for normalized metadata, tables, and text extraction.
     */
    private normalizeMarkdownTableOutput(markdown: string | null | undefined): string {
        if (typeof markdown !== "string" || markdown.trim().length === 0) {
            return "";
        }

        const lines = markdown.split("\n");
        while (lines.length > 0 && this.isEmptyMarkdownTableRow(lines[lines.length - 1])) {
            lines.pop();
        }

        return lines.join("\n").trim();
    }

    /**
     * Strips markdown-only scaffolding from Mistral OCR page output and keeps readable text.
     *
     * Current normalization removes:
     * - markdown image placeholders such as `![img](...)`
     * - table separator rows like `| --- | --- |`
     * - lines that only contain pipes/whitespace after cleanup
     *
     * @param {string} markdown Raw Mistral OCR page markdown.
     * @returns {string} Best-effort readable text extracted from the markdown.
     */
    private extractReadableTextFromMarkdown(markdown: string): string {
        // OCR markdown is often the closest thing Mistral returns to structured plain text,
        // so readable page text is derived from it even when formatting is imperfect.
        return markdown
            .split("\n")
            .map((line) => this.toReadableMarkdownLine(line))
            .filter((line) => line.length > 0)
            .join("\n")
            .trim();
    }

    /**
     * Converts a single markdown line into readable OCR text.
     *
     * @param {string} line Raw markdown line.
     * @returns {string} Readable text line or an empty string when the line is markdown-only scaffolding.
     */
    private toReadableMarkdownLine(line: string): string {
        if (this.isMarkdownTableSeparatorRow(line) || this.isEmptyMarkdownTableRow(line)) {
            return "";
        }

        const tableRow = this.extractReadableTableRow(line);
        if (tableRow !== undefined) {
            return tableRow;
        }

        return this.normalizeReadableMarkdownInlineText(line);
    }

    /**
     * Detects placeholder markdown table rows that contain only empty cells.
     *
     * Example matches:
     * - `|  |   |   |`
     * - `| | | |`
     *
     * @param {string | undefined} line Markdown line.
     * @returns {boolean} True when the row is a table row with no readable cell content.
     */
    private isEmptyMarkdownTableRow(line: string | undefined): boolean {
        if (typeof line !== "string") {
            return false;
        }

        const trimmed = line.trim();
        if (!trimmed.startsWith("|") || !trimmed.endsWith("|")) {
            return false;
        }

        const withoutPipes = trimmed.replace(/\|/g, "").trim();
        return withoutPipes.length === 0;
    }

    /**
     * Detects markdown table separator rows such as `| --- | --- |`.
     *
     * @param {string | undefined} line Markdown line.
     * @returns {boolean} True when the line is purely a markdown table separator.
     */
    private isMarkdownTableSeparatorRow(line: string | undefined): boolean {
        if (typeof line !== "string") {
            return false;
        }

        const normalized = line.replace(/\|/g, " ").trim();
        return normalized.length > 0 && /^[:\-\s]+$/u.test(normalized);
    }

    /**
     * Converts a markdown table row into readable cell text.
     *
     * @param {string} line Raw markdown line.
     * @returns {string | undefined} Readable row text, empty string for empty rows, or undefined when not table-like.
     */
    private extractReadableTableRow(line: string): string | undefined {
        const trimmed = line.trim();
        if (!trimmed.includes("|")) {
            return undefined;
        }

        const tableLike = trimmed.startsWith("|") || trimmed.endsWith("|") || trimmed.split("|").length >= 3;
        if (!tableLike) {
            return undefined;
        }

        const cells = trimmed
            .replace(/^\|/u, "")
            .replace(/\|$/u, "")
            .split("|")
            .map((cell) => this.normalizeReadableMarkdownInlineText(cell))
            .filter((cell) => cell.length > 0);

        return cells.join(" ").trim();
    }

    /**
     * Recovers hyperlink targets for page metadata.
     *
     * Mistral sometimes preserves markdown links in page markdown while leaving
     * `page.hyperlinks` empty. In that case, extract link targets from markdown so
     * OCR metadata remains useful for document-native formats like PPTX. This is
     * intentionally best-effort because OCR markdown can be malformed or incomplete.
     *
     * @param {OCRPageObject} page Raw OCR page.
     * @returns {string[] | undefined} Resolved hyperlinks when present.
     */
    private resolvePageHyperlinks(page: OCRPageObject): string[] | undefined {
        const links = new Set<string>();
        for (const value of page.hyperlinks ?? []) {
            const normalized = this.normalizeHyperlinkValue(value);
            if (normalized) {
                links.add(normalized);
            }
        }

        const markdown = typeof page.markdown === "string" ? page.markdown : "";
        if (markdown) {
            const markdownLinkRegex = /\[[^\]]+]\((https?:\/\/[^)\s]+)\)/g;
            for (const match of markdown.matchAll(markdownLinkRegex)) {
                const normalized = this.normalizeHyperlinkValue(match[1]);
                if (normalized) {
                    links.add(normalized);
                }
            }

            const autoLinkRegex = /<(https?:\/\/[^>\s]+)>/g;
            for (const match of markdown.matchAll(autoLinkRegex)) {
                const normalized = this.normalizeHyperlinkValue(match[1]);
                if (normalized) {
                    links.add(normalized);
                }
            }

            const markdownWithoutExplicitLinks = markdown.replace(markdownLinkRegex, " ").replace(autoLinkRegex, " ");
            const bareUrlRegex = /(^|[\s(])((https?:\/\/|www\.)[^\s)>]+)/g;
            for (const match of markdownWithoutExplicitLinks.matchAll(bareUrlRegex)) {
                const normalized = this.normalizeHyperlinkValue(match[2]);
                if (normalized) {
                    links.add(normalized);
                }
            }
        }

        return links.size > 0 ? [...links] : undefined;
    }

    /**
     * Removes markdown punctuation escaping from readable OCR text.
     *
     * Raw provider markdown remains preserved separately in `rawDocumentMarkdown`.
     *
     * @param {string} value Markdown-derived line.
     * @returns {string} Human-readable line with common escaped punctuation restored.
     */
    private unescapeMarkdownPunctuation(value: string): string {
        return value
            .replace(/\\\\/g, "\\")
            .replace(/\\-/g, "-")
            .replace(/\\,/g, ",")
            .replace(/\\\./g, ".")
            .replace(/\\!/g, "!")
            .replace(/\\\|/g, "|")
            .replace(/\\\(/g, "(")
            .replace(/\\\)/g, ")")
            .replace(/\\\[/g, "[")
            .replace(/\\\]/g, "]")
            .replace(/\\#/g, "#")
            .replace(/\\\*/g, "*")
            .replace(/\\_/g, "_")
            .replace(/\\\{/g, "{")
            .replace(/\\\}/g, "}")
            .replace(/\\`/g, "`");
    }

    /**
     * Normalizes hyperlink-like values recovered from metadata or markdown.
     *
     * @param {string | undefined} value Candidate link.
     * @returns {string | undefined} Normalized URL when valid.
     */
    private normalizeHyperlinkValue(value: string | undefined): string | undefined {
        if (typeof value !== "string") {
            return undefined;
        }

        const cleaned = this.unescapeMarkdownPunctuation(value.trim()).replace(/[),.;]+$/u, "");
        if (!cleaned) {
            return undefined;
        }

        const withProtocol = /^https?:\/\//i.test(cleaned) ? cleaned : /^www\./i.test(cleaned) ? `https://${cleaned}` : "";
        const candidate = withProtocol || cleaned;
        return /^https?:\/\//i.test(candidate) ? candidate : undefined;
    }

    /**
     * Normalizes inline markdown formatting into readable OCR text.
     *
     * @param {string} value Markdown-derived inline text.
     * @returns {string} Human-readable inline text.
     */
    private normalizeReadableMarkdownInlineText(value: string): string {
        const withLinks = value
            .replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, (_match, label: string, url: string) => {
                const normalizedLabel = this.unescapeMarkdownPunctuation(String(label).trim());
                const normalizedUrl = this.normalizeHyperlinkValue(String(url));
                if (normalizedUrl && normalizedLabel && !normalizedLabel.includes(normalizedUrl)) {
                    return `${normalizedLabel}: ${normalizedUrl}`;
                }
                return normalizedLabel || normalizedUrl || "";
            })
            .replace(/<(https?:\/\/[^>\s]+)>/g, (_match, url: string) => this.normalizeHyperlinkValue(String(url)) ?? "")
            .replace(/!\[[^\]]*]\([^)]+\)/g, " ");

        return this.stripOuterMarkdownEmphasis(
            this.stripMarkdownHeadingPrefix(this.unescapeMarkdownPunctuation(withLinks).replace(/[-:]{3,}/g, " "))
        )
            .replace(/\s+/g, " ")
            .trim();
    }

    /**
     * Removes simple outer markdown emphasis wrappers from a line of readable OCR text.
     *
     * Examples:
     * - `__Title__` -> `Title`
     * - `**Heading**` -> `Heading`
     *
     * Raw provider markdown remains available separately in `rawDocumentMarkdown`.
     *
     * @param {string} value Markdown-derived readable line.
     * @returns {string} Readable line without outer emphasis wrappers.
     */
    private stripOuterMarkdownEmphasis(value: string): string {
        return value
            .replace(/^__(.+)__$/u, "$1")
            .replace(/^\*\*(.+)\*\*$/u, "$1");
    }

    /**
     * Removes leading markdown heading markers from a readable line.
     *
     * Examples:
     * - `# Heading` -> `Heading`
     * - `## Section` -> `Section`
     *
     * Raw provider markdown remains available separately in `rawDocumentMarkdown`.
     *
     * @param {string} value Markdown-derived readable line.
     * @returns {string} Readable line without leading markdown heading markers.
     */
    private stripMarkdownHeadingPrefix(value: string): string {
        return value.replace(/^#{1,6}\s+/u, "");
    }

    /**
     * Converts OCR image coordinates into a normalized ProviderPlaneAI bounding box.
     *
     * Mistral OCR image annotations currently expose normalized corner coordinates,
     * which can be translated directly into the shared `BoundingBox` shape.
     *
     * @param {number | null | undefined} left Left coordinate.
     * @param {number | null | undefined} top Top coordinate.
     * @param {number | null | undefined} right Right coordinate.
     * @param {number | null | undefined} bottom Bottom coordinate.
     * @returns {BoundingBox | undefined} Normalized bounding box when usable coordinates are present.
     */
    private toBoundingBox(
        left?: number | null,
        top?: number | null,
        right?: number | null,
        bottom?: number | null
    ): BoundingBox | undefined {
        if ([left, top, right, bottom].some((value) => typeof value !== "number")) {
            return undefined;
        }

        const x1 = left as number;
        const y1 = top as number;
        const x2 = right as number;
        const y2 = bottom as number;
        if (x2 <= x1 || y2 <= y1) {
            return undefined;
        }

        return {
            x: x1,
            y: y1,
            width: x2 - x1,
            height: y2 - y1
        };
    }

    /**
     * Reads a Node readable stream into a single Uint8Array.
     *
     * @param {NodeJS.ReadableStream} stream Node readable stream input.
     * @param {AbortSignal} [signal] Optional cancellation signal.
     * @returns {Promise<Uint8Array>} Collected stream bytes.
     */
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

    /**
     * Returns true when the supplied file hint looks like an image URL.
     *
     * @param {string} value URL string to inspect.
     * @param {string} [mimeType] Optional MIME type hint.
     * @returns {boolean} Whether the URL likely points to an image.
     */
    private looksLikeImageUrl(value: string, mimeType?: string): boolean {
        if (this.isImageMimeType(mimeType)) {
            return true;
        }

        try {
            const pathname = new URL(value).pathname.toLowerCase();
            const extension = pathname.split(".").pop();
            return extension !== undefined && this.lookupFormatByExtension(extension)?.transport === "image";
        } catch {
            return false;
        }
    }

    /**
     * Returns true when the supplied MIME type is image-like.
     *
     * @param {string} [mimeType] MIME type hint.
     * @returns {boolean} Whether the MIME type indicates an image.
     */
    private isImageMimeType(mimeType?: string): boolean {
        if (typeof mimeType !== "string") {
            return false;
        }

        const normalizedMimeType = mimeType.toLowerCase();
        return this.lookupFormatByMimeType(normalizedMimeType)?.transport === "image" || /^image\//i.test(normalizedMimeType);
    }

    /**
     * Extracts MIME type metadata from a data URI if present.
     *
     * @param {string} dataUri Data URI string.
     * @returns {string | undefined} MIME type when present.
     */
    private extractDataUriMimeType(dataUri: string): string | undefined {
        const match = dataUri.match(/^data:([^;,]+)[;,]/i);
        return match?.[1];
    }

    /**
     * Derives a stable upload filename for file-backed OCR inputs.
     *
     * Mistral accepts uploaded files directly for OCR. When callers provide bytes without a
     * filename, preserving a format-specific extension improves document-type detection for
     * formats like PDF/DOCX/PPTX.
     *
     * @param {string} [filename] Caller-supplied filename hint.
     * @param {string} [mimeType] MIME type hint.
     * @returns {string} Upload filename with best-effort extension.
     */
    private resolveUploadFilename(filename?: string, mimeType?: string): string {
        if (filename && filename.trim().length > 0) {
            return filename;
        }

        const extension = this.fileExtensionForMimeType(mimeType);
        return extension ? `${DEFAULT_OCR_FILENAME}.${extension}` : DEFAULT_OCR_FILENAME;
    }

    /**
     * Maps selected OCR document MIME types to filename extensions.
     *
     * @param {string} [mimeType] MIME type hint.
     * @returns {string | undefined} File extension without leading dot.
     */
    private fileExtensionForMimeType(mimeType?: string): string | undefined {
        return this.lookupFormatByMimeType((mimeType ?? "").toLowerCase())?.extension;
    }

    /**
     * Looks up a registered OCR format by file extension.
     *
     * @param {string} extension File extension without a leading dot.
     * @returns {MistralOCRFormatDescriptor | undefined} Registered format descriptor, if known.
     */
    private lookupFormatByExtension(extension: string): MistralOCRFormatDescriptor | undefined {
        return MISTRAL_OCR_EXTENSION_TO_FORMAT.get(extension.toLowerCase());
    }

    /**
     * Looks up a registered OCR format by MIME type.
     *
     * @param {string} mimeType MIME type to resolve.
     * @returns {MistralOCRFormatDescriptor | undefined} Registered format descriptor, if known.
     */
    private lookupFormatByMimeType(mimeType: string): MistralOCRFormatDescriptor | undefined {
        return MISTRAL_OCR_MIME_TO_FORMAT.get(mimeType.toLowerCase());
    }

    /**
     * Best-effort extraction of a Blob/File name.
     *
     * @param {Blob} blob Browser Blob/File input.
     * @returns {string | undefined} Name when present.
     */
    private extractBlobName(blob: Blob): string | undefined {
        return "name" in blob && typeof blob.name === "string" ? blob.name : undefined;
    }

    /**
     * Returns true when a value behaves like a Node readable stream.
     *
     * @param {unknown} value Candidate input.
     * @returns {boolean} Whether the value is a readable stream.
     */
    private isNodeReadableStream(value: unknown): value is NodeJS.ReadableStream {
        return typeof value === "object" && value !== null && typeof (value as NodeJS.ReadableStream).pipe === "function";
    }
}
