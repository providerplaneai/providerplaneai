/**
 * @module providers/anthropic/capabilities/AnthropicOCRCapabilityImpl.ts
 * @description Anthropic OCR capability adapter.
 */
import Anthropic from "@anthropic-ai/sdk";
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
    inferMimeTypeFromFilename,
    isImageMimeType,
    isLikelyImagePath,
    MultiModalExecutionContext,
    NormalizedOCRDocument,
    OCRCapability,
    OCRText,
    normalizeOCRAnnotationText,
    normalizeOCRTextValue,
    parseBestEffortJson,
    resolveReferenceMediaSource,
    resolveBinarySourceToBase64,
    stripMarkdownCodeFence,
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

/**
 * Adapts Anthropic OCR responses into ProviderPlaneAI's normalized OCR artifact surface.
 *
 * Anthropic OCR support in this repo is effectively limited to PDF plus the
 * image formats Anthropic accepts directly. Broader document/text inputs are
 * intentionally left for the provider to reject rather than being guarded here.
 *
 * @public
 */
export class AnthropicOCRCapabilityImpl implements OCRCapability<ClientOCRRequest, NormalizedOCRDocument[]> {
    /**
     * Creates a new Anthropic OCR capability adapter.
     *
     * @param {BaseProvider} provider Owning provider instance used for initialization checks and merged config access.
     * @param {Anthropic} client Initialized Anthropic SDK client.
     */
    constructor(
        private readonly provider: BaseProvider,
        private readonly client: Anthropic
    ) {}

    /**
     * Executes OCR through Anthropic messages with structured prompt guidance.
     *
     * Responsibilities:
     * - validate the OCR input shape
     * - resolve merged model/runtime options
     * - build Anthropic message content from images or file input
     * - parse best-effort JSON from the generated response
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
        const parsedItems = parseBestEffortJson<AnthropicOCRPayload>(stripMarkdownCodeFence(responseText));
        const document = this.normalizeOCRDocument(input, parsedItems[0], responseText, responseId);

        return {
            output: [document],
            multimodalArtifacts: { ocr: [document] },
            id: responseId,
            rawResponse: response,
            metadata: buildMetadata(context?.metadata, {
                provider: AIProvider.Anthropic,
                model: merged.model,
                status: "completed",
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
            throw new Error("Anthropic OCR accepts either `file` or `images`, not both");
        }
    }

    /**
     * Builds the Anthropic messages payload for OCR execution.
     *
     * @param {ClientOCRRequest} input OCR request input.
     * @returns {Promise<any[]>} Anthropic messages payload.
     */
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

    /**
     * Normalizes parsed OCR payload and fallback output text into a unified OCR document.
     *
     * @param {ClientOCRRequest} input Original OCR request input.
     * @param {AnthropicOCRPayload | undefined} parsed Parsed structured OCR payload when available.
     * @param {string} rawText Fallback plain-text OCR output extracted from the response.
     * @param {string} responseId Stable response identifier for the normalized artifact.
     * @returns {NormalizedOCRDocument} Provider-normalized OCR document.
     */
    private normalizeOCRDocument(
        input: ClientOCRRequest,
        parsed: AnthropicOCRPayload | undefined,
        rawText: string,
        responseId: string
    ): NormalizedOCRDocument {
        const parsedPages = parsed?.pages
            ?.map((page, index) => ({
                pageNumber: page.pageNumber ?? index + 1,
                fullText: normalizeOCRTextValue(page.fullText),
                text: normalizeOCRTextValue(page.fullText)
                    ? ([{ text: normalizeOCRTextValue(page.fullText)! }] satisfies OCRText[])
                    : undefined
            }))
            .filter((page) => page.fullText || page.text);

        const pageTexts = parsedPages?.map((page) => page.fullText).filter((value): value is string => Boolean(value)) ?? [];
        const fullText =
            normalizeOCRTextValue(parsed?.fullText) || pageTexts.join("\n\n").trim() || rawText.trim() || undefined;

        return {
            id: responseId,
            fullText,
            text: fullText ? [{ text: fullText }] : undefined,
            pages: parsedPages,
            language: normalizeOCRTextValue(parsed?.language) ?? input.language,
            pageCount: parsedPages?.length,
            fileName: input.filename,
            mimeType: input.mimeType,
            sourceImageId: input.images?.[0]?.id,
            annotations: parsed?.annotations
                ?.filter((annotation) => annotation && (annotation.text || annotation.data))
                .map((annotation) => ({
                    type: annotation.type === "bbox" ? "bbox" : "document",
                    ...(annotation.label ? { label: annotation.label } : {}),
                    ...(normalizeOCRAnnotationText(annotation.text, annotation.data, input.structured?.annotationPrompt)
                        ? {
                              text: normalizeOCRAnnotationText(
                                  annotation.text,
                                  annotation.data,
                                  input.structured?.annotationPrompt
                              )
                          }
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
            metadata: buildMetadata(undefined, {
                provider: AIProvider.Anthropic,
                status: "completed",
                rawParsed: parsed
            })
        };
    }

    private async toAnthropicImagePart(image: ClientReferenceImage) {
        const resolved = resolveReferenceMediaSource(
            image,
            "image/png",
            "Anthropic OCR image inputs require image.base64 or image.url"
        );

        if (resolved.kind === "base64") {
            return {
                type: "image",
                source: {
                    type: "base64",
                    media_type: resolved.mimeType,
                    data: resolved.base64
                }
            };
        }

        return {
            type: "image",
            source: {
                type: "url",
                url: resolved.url
            }
        };
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

                if (isImageMimeType(resolvedMimeType) || isLikelyImagePath(file)) {
                    return {
                        type: "image",
                        source: {
                            type: "url",
                            url: file
                        }
                    };
                }
            }
        }

        const resolved = await resolveBinarySourceToBase64(file, {
            filenameHint: filename,
            mimeTypeHint: mimeType,
            defaultFileName: "ocr-input",
            defaultMimeType: resolvedMimeType,
            inferMimeTypeFromPath: (filePath: string) => inferMimeTypeFromFilename(filePath) ?? resolvedMimeType,
            invalidStringMessage: "Unsupported Anthropic OCR input type"
        });
        return this.base64SourcePart(resolved.base64, resolved.mimeType, filename ?? resolved.fileName);
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

        if (isImageMimeType(mimeType)) {
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
}
