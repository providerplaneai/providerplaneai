/**
 * @module providers/mistral/capabilities/MistralImageAnalysisCapabilityImpl.ts
 * @description Mistral image analysis capability adapter.
 */
import { Mistral } from "@mistralai/mistralai";
import type { ChatCompletionRequest, ContentChunk, UserMessage } from "@mistralai/mistralai/models/components";
import {
    AIProvider,
    AIRequest,
    AIResponse,
    AIResponseChunk,
    BaseProvider,
    CapabilityKeys,
    ClientImageAnalysisRequest,
    ClientReferenceImage,
    ImageAnalysisCapability,
    ImageAnalysisStreamCapability,
    MultiModalExecutionContext,
    NormalizedImage,
    NormalizedImageAnalysis,
    ensureDataUri,
    parseBestEffortJson
} from "#root/index.js";

const DEFAULT_MISTRAL_IMAGE_ANALYSIS_MODEL = "mistral-small-latest";
const DEFAULT_MISTRAL_IMAGE_ANALYSIS_PROMPT = `
Analyze EACH image independently and return ONLY JSON.

Return a JSON array. Each element should describe exactly one image with:
- imageIndex
- description
- tags
- objects
- text
- safety

Do not include markdown or explanation outside JSON.
`;

type MistralImageAnalysisPayload = {
    imageIndex?: number;
    description?: string;
    tags?: string[];
    objects?: Array<{ label?: string }>;
    text?: Array<{ text?: string; confidence?: number }>;
    safety?: {
        flagged?: boolean;
        categories?: Record<string, boolean>;
    };
};

/**
 * MistralImageAnalysisCapabilityImpl: adapts Mistral multimodal chat completions
 * into ProviderPlaneAI's normalized image analysis artifact surface.
 *
 * Current v1 behavior:
 * - uses Mistral chat completions for image understanding
 * - requests JSON output via prompt + `responseFormat`
 * - parses best-effort JSON and normalizes it into `NormalizedImageAnalysis[]`
 * - uses a thin stream wrapper that emits the final normalized result once complete
 *
 * @public
 * @description Provider capability implementation for MistralImageAnalysisCapabilityImpl.
 */
export class MistralImageAnalysisCapabilityImpl
    implements ImageAnalysisCapability<ClientImageAnalysisRequest>, ImageAnalysisStreamCapability<ClientImageAnalysisRequest>
{
    /**
     * Creates a new Mistral image analysis capability adapter.
     *
     * @param {BaseProvider} provider Owning provider instance used for initialization checks and merged config access.
     * @param {Mistral} client Initialized official Mistral SDK client.
     */
    constructor(
        private readonly provider: BaseProvider,
        private readonly client: Mistral
    ) {}

    /**
     * Executes a non-streaming Mistral image analysis request.
     *
     * Responsibilities:
     * - resolve images from explicit request input or execution context
     * - execute multimodal `chat.complete` with a JSON-oriented prompt
     * - parse provider output with best-effort JSON handling
     * - normalize parsed image analyses into `NormalizedImageAnalysis[]`
     *
     * @param {AIRequest<ClientImageAnalysisRequest>} request Unified image analysis request envelope.
     * @param {MultiModalExecutionContext} [executionContext] Optional execution context for fallback image sourcing.
     * @param {AbortSignal} [signal] Optional cancellation signal.
     * @throws {Error} When no images are provided or execution is aborted before the request starts.
     * @returns {Promise<AIResponse<NormalizedImageAnalysis[]>>} Provider-normalized image analysis artifacts.
     */
    async analyzeImage(
        request: AIRequest<ClientImageAnalysisRequest>,
        executionContext?: MultiModalExecutionContext,
        signal?: AbortSignal
    ): Promise<AIResponse<NormalizedImageAnalysis[]>> {
        this.provider.ensureInitialized();

        const { input, options, context } = request;
        const images = input.images ?? this.toReferenceImages(executionContext?.getLatestImages() ?? []);
        if (!images.length) {
            throw new Error("At least one image is required for analysis");
        }
        if (signal?.aborted) {
            throw new Error("Image analysis aborted before request started");
        }

        const merged = this.provider.getMergedOptions(CapabilityKeys.ImageAnalysisCapabilityKey, options);
        const prompt = input.prompt?.trim() || DEFAULT_MISTRAL_IMAGE_ANALYSIS_PROMPT.trim();
        // Vision is modeled as multimodal chat for Mistral, so the adapter keeps
        // the provider-specific prompt/response formatting local here.
        const response = await this.client.chat.complete(
            this.buildImageAnalysisRequest(
                merged.model ?? DEFAULT_MISTRAL_IMAGE_ANALYSIS_MODEL,
                images,
                prompt,
                merged.modelParams
            ),
            { signal, ...(merged.providerParams ?? {}) }
        );

        const text = this.extractMessageText(response.choices?.[0]?.message?.content ?? undefined);
        // Providers do not always emit perfect JSON even in "json_object" mode;
        // use best-effort parsing so the workflow layer still gets a usable artifact.
        const parsed = parseBestEffortJson<MistralImageAnalysisPayload>(text);
        const normalized = this.normalizeAnalyses(parsed, images);

        return {
            output: normalized,
            rawResponse: response,
            id: response.id ?? crypto.randomUUID(),
            metadata: {
                ...(context?.metadata ?? {}),
                provider: AIProvider.Mistral,
                model: merged.model ?? response.model ?? DEFAULT_MISTRAL_IMAGE_ANALYSIS_MODEL,
                status: "completed",
                requestId: context?.requestId
            }
        };
    }

    /**
     * Executes a streaming Mistral image analysis request.
     *
     * Current v1 behavior intentionally keeps this simple: it reuses the non-stream
     * path and emits one terminal normalized chunk.
     *
     * @param {AIRequest<ClientImageAnalysisRequest>} request Unified image analysis request envelope.
     * @param {MultiModalExecutionContext} [executionContext] Optional execution context for fallback image sourcing.
     * @param {AbortSignal} [signal] Optional cancellation signal.
     * @returns {AsyncGenerator<AIResponseChunk<NormalizedImageAnalysis[]>>} Async generator emitting one final normalized chunk.
     */
    async *analyzeImageStream(
        request: AIRequest<ClientImageAnalysisRequest>,
        executionContext?: MultiModalExecutionContext,
        signal?: AbortSignal
    ): AsyncGenerator<AIResponseChunk<NormalizedImageAnalysis[]>> {
        const response = await this.analyzeImage(request, executionContext, signal);
        yield {
            delta: response.output,
            output: response.output,
            done: true,
            id: response.id,
            metadata: response.metadata
        };
    }

    /**
     * Builds Mistral multimodal chat content for image analysis.
     *
     * @param {ClientReferenceImage[]} images Images to analyze.
     * @param {string} prompt Analysis prompt text.
     * @returns {Array<ContentChunk>} SDK-compatible multimodal message content.
     */
    private buildVisionContent(images: ClientReferenceImage[], prompt: string): Array<ContentChunk> {
        const content: Array<ContentChunk> = [{ type: "text", text: prompt }];
        for (const image of images) {
            content.push({
                type: "image_url",
                imageUrl: image.url ?? ensureDataUri(image.base64 ?? "", image.mimeType)
            });
        }
        return content;
    }

    /**
     * Flattens Mistral assistant content into plain text for JSON parsing.
     *
     * @param {string | Array<ContentChunk> | undefined} content Provider message content.
     * @returns {string} Flattened text content.
     */
    private extractMessageText(content: string | Array<ContentChunk> | undefined): string {
        if (!content) {
            return "";
        }
        if (typeof content === "string") {
            return content;
        }
        return content
            .filter(
                (part): part is Extract<ContentChunk, { type: "text" }> =>
                    part?.type === "text" && "text" in part && typeof part.text === "string"
            )
            .map((part) => part.text)
            .join("");
    }

    /**
     * Normalizes best-effort parsed Mistral analysis payloads into provider-agnostic artifacts.
     *
     * @param {Array<MistralImageAnalysisPayload | string>} payload Parsed payload fragments.
     * @param {ClientReferenceImage[]} images Source images corresponding to the request.
     * @returns {NormalizedImageAnalysis[]} Provider-normalized image analysis artifacts.
     */
    private normalizeAnalyses(
        payload: Array<MistralImageAnalysisPayload | string>,
        images: ClientReferenceImage[]
    ): NormalizedImageAnalysis[] {
        const objects = payload.filter((item): item is MistralImageAnalysisPayload => !!item && typeof item === "object");
        if (objects.length === 0) {
            return images.map((image, index) => ({
                id: crypto.randomUUID(),
                description: typeof payload[0] === "string" && index === 0 ? payload[0] : undefined,
                sourceImageId: image.id
            }));
        }

        return objects.map((item, index) => ({
            id: crypto.randomUUID(),
            description: item.description,
            tags: item.tags,
            objects: item.objects
                ?.filter((obj) => typeof obj?.label === "string" && obj.label.length > 0)
                .map((obj) => ({ label: obj.label! })),
            text: item.text
                ?.filter((entry) => typeof entry?.text === "string" && entry.text.length > 0)
                .map((entry) => ({ text: entry.text!, confidence: entry.confidence })),
            safety: item.safety
                ? {
                      flagged: Boolean(item.safety.flagged),
                      categories: item.safety.categories
                  }
                : undefined,
            sourceImageId: images[item.imageIndex ?? index]?.id ?? images[index]?.id
        }));
    }

    /**
     * Converts execution-context images into request-style reference images.
     *
     * The workflow/runtime execution context stores normalized image artifacts,
     * but the provider request surface expects `ClientReferenceImage`.
     *
     * @param {NormalizedImage[]} images Normalized context images.
     * @returns {ClientReferenceImage[]} Request-compatible reference images.
     */
    private toReferenceImages(images: NormalizedImage[]): ClientReferenceImage[] {
        return images
            .filter((image) => image.url || image.base64)
            .map((image) => ({
                id: image.id,
                sourceType: image.url ? "url" : "base64",
                url: image.url,
                base64: image.base64,
                mimeType: image.mimeType
            }));
    }

    /**
     * Builds a typed multimodal chat request for Mistral image analysis.
     *
     * @param {string} model Resolved model name.
     * @param {ClientReferenceImage[]} images Images to analyze.
     * @param {string} prompt Analysis prompt.
     * @param {Record<string, unknown> | undefined} modelParams Provider/model-specific request overrides.
     * @returns {ChatCompletionRequest} SDK-compatible chat completion request.
     */
    private buildImageAnalysisRequest(
        model: string,
        images: ClientReferenceImage[],
        prompt: string,
        modelParams?: Record<string, unknown>
    ): ChatCompletionRequest {
        const userMessage: UserMessage = {
            role: "user",
            content: this.buildVisionContent(images, prompt)
        };

        return {
            model,
            messages: [userMessage],
            responseFormat: { type: "json_object" },
            ...(modelParams ?? {})
        } as ChatCompletionRequest;
    }
}
