/**
 * @module providers/gemini/capabilities/GeminiOCRCapabilityImpl.ts
 * @description Gemini OCR capability adapter.
 */
import { GoogleGenAI } from "@google/genai";
import {
    AIProvider,
    AIRequest,
    AIResponse,
    assertSafeRemoteHttpUrl,
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
    normalizeOCRAnnotationText,
    parseBestEffortJson,
    resolveReferenceMediaSource,
    resolveBinarySourceToBase64,
    stripMarkdownCodeFence,
    buildMetadata,
    normalizeOCRTextValue
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
 * Adapts Gemini OCR responses into ProviderPlaneAI's normalized OCR artifact surface.
 *
 * Gemini does not expose a dedicated OCR endpoint here, so OCR is implemented as
 * prompt-driven multimodal extraction over images and documents via `generateContent`.
 *
 * Practical support is narrower than Mistral OCR in this repo. The most reliable
 * document/image path is PDF plus Gemini's supported image formats; some
 * text-like and office-document inputs can fail slowly at the provider layer.
 *
 * @public
 */
export class GeminiOCRCapabilityImpl implements OCRCapability<ClientOCRRequest, NormalizedOCRDocument[]> {
    /**
     * Creates a new Gemini OCR capability adapter.
     *
     * @param {BaseProvider} provider Owning provider instance used for initialization checks and merged config access.
     * @param {GoogleGenAI} client Initialized Google GenAI SDK client.
     */
    constructor(
        private readonly provider: BaseProvider,
        private readonly client: GoogleGenAI
    ) {}

    /**
     * Executes OCR through Gemini multimodal content generation.
     *
     * Responsibilities:
     * - validate the OCR input shape
     * - resolve merged model/runtime options
     * - build Gemini user content from images or file input
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
        const parsedItems = parseBestEffortJson<GeminiOCRPayload>(stripMarkdownCodeFence(responseText));
        const parsedPayload = this.isDegenerateParsedPayload(parsedItems[0]) ? undefined : parsedItems[0];
        const document = this.normalizeOCRDocument(input, parsedPayload, responseText, responseId);

        return {
            output: [document],
            multimodalArtifacts: { ocr: [document] },
            id: responseId,
            rawResponse: response,
            metadata: buildMetadata(context?.metadata, {
                provider: AIProvider.Gemini,
                model,
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
            throw new Error("Gemini OCR accepts either `file` or `images`, not both");
        }
    }

    /**
     * Builds the Gemini multimodal user content payload for OCR execution.
     *
     * @param {ClientOCRRequest} input OCR request input.
     * @returns {Promise<{ role: "user"; parts: Array<{ text: string } | { inlineData: { mimeType: string; data: string } } | { fileData: { mimeType: string; fileUri: string } }> }>} Gemini user content payload.
     */
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
                parts.push(await this.toGeminiImagePart(image));
            }
        } else if (input.file !== undefined) {
            parts.push(await this.toGeminiFilePart(input.file, input.mimeType, input.filename));
        }

        return {
            role: "user",
            parts
        };
    }

    /**
     * Builds the OCR extraction prompt sent alongside the file or image input.
     *
     * @param {ClientOCRRequest} input OCR request input.
     * @returns {string} Provider instruction text for OCR extraction.
     */
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

        const instructions = [basePrompt.join("\n"), `Return JSON matching this shape:\n${targetShape}`];

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
     * @param {GeminiOCRPayload | undefined} parsed Parsed structured OCR payload when available.
     * @param {string} rawText Fallback plain-text OCR output extracted from the response.
     * @param {string} responseId Stable response identifier for the normalized artifact.
     * @returns {NormalizedOCRDocument} Provider-normalized OCR document.
     */
    private normalizeOCRDocument(
        input: ClientOCRRequest,
        parsed: GeminiOCRPayload | undefined,
        rawText: string,
        responseId: string
    ): NormalizedOCRDocument {
        const parsedPages = parsed?.pages
            ?.map((page, index) => {
                const pageFullText = normalizeOCRTextValue(page.fullText);
                return {
                    pageNumber: page.pageNumber ?? index + 1,
                    fullText: pageFullText,
                    text: pageFullText ? ([{ text: pageFullText }] satisfies OCRText[]) : undefined
                };
            })
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
                .map((annotation) => {
                    const annotationText = normalizeOCRAnnotationText(
                        annotation.text,
                        annotation.data,
                        input.structured?.annotationPrompt
                    );
                    return {
                        type: annotation.type === "bbox" ? "bbox" : "document",
                        ...(annotation.label ? { label: annotation.label } : {}),
                        ...(annotationText ? { text: annotationText } : {}),
                        ...(annotation.data ? { data: annotation.data } : {}),
                        ...(annotation.pageNumber ? { pageNumber: annotation.pageNumber } : {})
                    };
                }),
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
                provider: AIProvider.Gemini,
                status: "completed"
            })
        };
    }

    private isDegenerateParsedPayload(parsed: GeminiOCRPayload | undefined): boolean {
        if (!parsed || typeof parsed !== "object") {
            return false;
        }
        const fullText = normalizeOCRTextValue(parsed.fullText);
        const hasPages = parsed.pages?.some((page) => normalizeOCRTextValue(page?.fullText)) ?? false;
        const hasAnnotations =
            parsed.annotations?.some(
                (annotation) => normalizeOCRTextValue(annotation?.text) || annotation?.data !== undefined
            ) ?? false;
        const hasHeaders = parsed.headers?.some((section) => normalizeOCRTextValue(section?.text)) ?? false;
        const hasFooters = parsed.footers?.some((section) => normalizeOCRTextValue(section?.text)) ?? false;
        if (fullText && fullText !== "true" && fullText !== "false") {
            return false;
        }
        return !(hasPages || hasAnnotations || hasHeaders || hasFooters);
    }

    private async toGeminiImagePart(img: ClientReferenceImage) {
        const resolved = resolveReferenceMediaSource(
            img,
            "image/png",
            "Gemini OCR image inputs require image.base64 or image.url"
        );

        if (resolved.kind === "base64") {
            return {
                inlineData: {
                    mimeType: resolved.mimeType,
                    data: resolved.base64
                }
            };
        }

        await assertSafeRemoteHttpUrl(resolved.url);
        return {
            fileData: {
                mimeType: resolved.mimeType,
                fileUri: resolved.url
            }
        };
    }

    private async toGeminiFilePart(file: ClientFileInputSource, mimeType?: string, filename?: string) {
        const resolvedMimeType = mimeType ?? inferMimeTypeFromFilename(filename) ?? "application/octet-stream";

        if (typeof file === "string" && /^https?:\/\//i.test(file)) {
            await assertSafeRemoteHttpUrl(file);
            return {
                fileData: {
                    mimeType: resolvedMimeType,
                    fileUri: file
                }
            };
        }

        const resolved = await resolveBinarySourceToBase64(file, {
            filenameHint: filename,
            mimeTypeHint: mimeType,
            defaultFileName: "ocr-input",
            defaultMimeType: resolvedMimeType,
            inferMimeTypeFromPath: (filePath) => inferMimeTypeFromFilename(filePath) ?? resolvedMimeType,
            invalidStringMessage: "Unsupported Gemini OCR input type"
        });

        return {
            inlineData: {
                mimeType: resolved.mimeType,
                data: resolved.base64
            }
        };
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
}
