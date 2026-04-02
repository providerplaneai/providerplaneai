/**
 * @module providers/mistral/capabilities/MistralOCRCapabilityImpl.ts
 * @description Mistral OCR capability adapter.
 */
import { Mistral } from "@mistralai/mistralai";
import type { FileT, OCRRequest, OCRResponse } from "@mistralai/mistralai/models/components";
export { MISTRAL_OCR_FORMATS } from "./shared/MistralOCRInputUtils.js";
import {
    AIProvider,
    AIRequest,
    AIResponse,
    BaseProvider,
    buildMetadata,
    CapabilityKeys,
    ClientOCRRequest,
    type MistralOCRDocumentInput,
    resolveMistralOCRDocumentInput,
    MultiModalExecutionContext,
    normalizeMistralOCRResponse,
    NormalizedOCRDocument,
    OCRCapability
} from "#root/index.js";

const DEFAULT_MISTRAL_OCR_MODEL = "mistral-ocr-latest";
const DEFAULT_OCR_FILENAME = "ocr-input";

/**
 * Adapts Mistral's `/v1/ocr` endpoint into ProviderPlaneAI OCR document artifacts.
 *
 * Accepts exactly one OCR source per request, routes remote inputs as image or
 * document references when possible, uploads local or byte-backed inputs to
 * Mistral files when needed, and normalizes OCR page markdown into readable
 * document and page text output.
 *
 * @public
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
            metadata: buildMetadata(context?.metadata, {
                provider: AIProvider.Mistral,
                model: response.model ?? model,
                status: "completed",
                requestId: context?.requestId,
                pagesProcessed: response.pages.length,
                documentPages: response.pages.length,
                ...(typeof response.usageInfo?.pagesProcessed === "number"
                    ? { pagesProcessed: response.usageInfo.pagesProcessed }
                    : {})
            })
        };
    }

    /**
     * Ensures the request carries exactly one OCR source.
     *
     * @param {ClientOCRRequest} input OCR request input.
     * @throws {Error} When no source or multiple sources are supplied.
     * @returns {void} Nothing. Throws when the request contains an unsupported source combination.
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
            ...(modelParams ?? {}),
            model,
            document,
            ...(bboxAnnotationFormat ? { bboxAnnotationFormat } : {}),
            ...(documentAnnotationFormat ? { documentAnnotationFormat } : {}),
            ...(annotationPrompt && documentAnnotationFormat ? { documentAnnotationPrompt: annotationPrompt } : {}),
            ...(tableFormat !== undefined ? { tableFormat } : {}),
            ...(structured?.pages?.length ? { pages: structured.pages.map((page) => Math.max(0, page - 1)) } : {}),
            ...(structured?.extractHeaders ? { extractHeader: true } : {}),
            ...(structured?.extractFooters ? { extractFooter: true } : {}),
            ...(input.includeBoundingBoxes ? { includeImageBase64: true } : {})
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
                    ...(annotationSchema.description ? { description: annotationSchema.description } : {}),
                    schemaDefinition: annotationSchema.schema,
                    ...(annotationSchema.strict !== undefined ? { strict: annotationSchema.strict } : {})
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
                    ...(annotationSchema.description ? { description: annotationSchema.description } : {}),
                    schemaDefinition: annotationSchema.schema,
                    ...(annotationSchema.strict !== undefined ? { strict: annotationSchema.strict } : {})
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
    private async resolveDocumentInput(input: ClientOCRRequest, signal?: AbortSignal): Promise<MistralOCRDocumentInput> {
        return resolveMistralOCRDocumentInput(input, {
            signal,
            defaultFileName: DEFAULT_OCR_FILENAME,
            uploadFile: (file, uploadSignal) => this.uploadFile(file, uploadSignal)
        });
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
    private normalizeResponse(response: OCRResponse, input: ClientOCRRequest, requestId?: string): NormalizedOCRDocument {
        return normalizeMistralOCRResponse(response, input, requestId);
    }
}
