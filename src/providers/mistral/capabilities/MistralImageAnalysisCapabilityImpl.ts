/**
 * @module providers/mistral/capabilities/MistralImageAnalysisCapabilityImpl.ts
 * @description Mistral image analysis capability adapter.
 */
import { Mistral } from "@mistralai/mistralai";
import type { ChatCompletionRequest, CompletionEvent, ContentChunk, UserMessage } from "@mistralai/mistralai/models/components";
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
    parseBestEffortJson,
    resolveReferenceMediaUrl,
    buildMetadata
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
 * Adapts Mistral multimodal chat completions into ProviderPlaneAI's normalized
 * image analysis artifact surface.
 *
 * Uses Mistral chat completions for image understanding, requests JSON-shaped
 * output via prompt plus `responseFormat`, and normalizes best-effort parsed
 * results into `NormalizedImageAnalysis[]`. Stream mode uses Mistral chat
 * streaming, emits best-effort incremental normalized chunks once structured
 * payloads emerge from partial JSON, suppresses duplicate incremental states,
 * and always finishes with one terminal chunk containing the final normalized output.
 *
 * @public
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
        const model = merged.model ?? DEFAULT_MISTRAL_IMAGE_ANALYSIS_MODEL;
        const analysisRequest = this.buildImageAnalysisRequest(model, images, prompt, merged.modelParams);
        // Vision is modeled as multimodal chat for Mistral, so the adapter keeps
        // the provider-specific prompt/response formatting local here.
        const response = await this.client.chat.complete(analysisRequest, { signal, ...(merged.providerParams ?? {}) });

        const responseText = this.extractMessageText(response.choices?.[0]?.message?.content ?? undefined);
        // Providers do not always emit perfect JSON even in "json_object" mode;
        // use best-effort parsing so the workflow layer still gets a usable artifact.
        const parsed = parseBestEffortJson<MistralImageAnalysisPayload>(responseText);
        const normalized = this.normalizeAnalyses(parsed, images);

        return {
            output: normalized,
            rawResponse: response,
            id: response.id ?? crypto.randomUUID(),
            metadata: buildMetadata(context?.metadata, {
                provider: AIProvider.Mistral,
                model,
                status: "completed",
                requestId: context?.requestId
            })
        };
    }

    /**
     * Executes a streaming Mistral image analysis request.
     *
     * Streams best-effort normalized image analysis output by incrementally parsing
     * partial JSON text from Mistral chat deltas. Incremental chunks are only
     * emitted once best-effort parsing yields structured payloads, duplicate
     * incremental states are suppressed, and the stream always ends with one
     * terminal completed chunk containing the final normalized output.
     *
     * @param {AIRequest<ClientImageAnalysisRequest>} request Unified image analysis request envelope.
     * @param {MultiModalExecutionContext} [executionContext] Optional execution context for fallback image sourcing.
     * @param {AbortSignal} [signal] Optional cancellation signal.
     * @returns {AsyncGenerator<AIResponseChunk<NormalizedImageAnalysis[]>>} Async generator emitting incremental and terminal normalized chunks.
     */
    async *analyzeImageStream(
        request: AIRequest<ClientImageAnalysisRequest>,
        executionContext?: MultiModalExecutionContext,
        signal?: AbortSignal
    ): AsyncGenerator<AIResponseChunk<NormalizedImageAnalysis[]>> {
        this.provider.ensureInitialized();

        const { input, options, context } = request;
        const images = input.images ?? this.toReferenceImages(executionContext?.getLatestImages() ?? []);
        if (!images.length) {
            throw new Error("At least one image is required for analysis");
        }

        const merged = this.provider.getMergedOptions(CapabilityKeys.ImageAnalysisStreamCapabilityKey, options);
        const prompt = input.prompt?.trim() || DEFAULT_MISTRAL_IMAGE_ANALYSIS_PROMPT.trim();
        const model = merged.model ?? DEFAULT_MISTRAL_IMAGE_ANALYSIS_MODEL;
        const analysisRequest = this.buildImageAnalysisRequest(model, images, prompt, merged.modelParams);

        let responseId: string | undefined;
        let accumulatedText = "";
        let lastEmissionSignature: string | undefined;

        try {
            if (signal?.aborted) {
                throw new Error("Image analysis aborted before request started");
            }

            const stream = await this.client.chat.stream(analysisRequest, { signal, ...(merged.providerParams ?? {}) });

            for await (const event of stream as AsyncIterable<CompletionEvent>) {
                if (signal?.aborted) {
                    return;
                }

                responseId ??= event?.data?.id;
                const deltaText = this.extractMessageText(event?.data?.choices?.[0]?.delta?.content);
                if (!deltaText) {
                    continue;
                }

                accumulatedText += deltaText;
                // Partial JSON may still be malformed mid-stream; best-effort parsing lets
                // downstream consumers see progressively improving analysis output.
                const parsed = parseBestEffortJson<MistralImageAnalysisPayload>(accumulatedText);
                const hasStructuredPayload = parsed.some((item) => !!item && typeof item === "object");
                const deltaAnalyses = this.normalizeAnalyses(parsed, images);
                const emissionSignature = JSON.stringify(deltaAnalyses.map(({ id: _id, ...analysis }) => analysis));

                // Skip noisy fallback chunks while JSON is still incomplete; wait until we have
                // at least one parsed object before emitting incremental analysis updates.
                if (!hasStructuredPayload) {
                    continue;
                }

                // Structured incremental output can stabilize across multiple provider deltas.
                // Suppress duplicate emissions to keep playground/log output readable.
                if (emissionSignature === lastEmissionSignature) {
                    continue;
                }
                lastEmissionSignature = emissionSignature;

                yield {
                    delta: deltaAnalyses,
                    output: deltaAnalyses,
                    done: false,
                    id: responseId ?? crypto.randomUUID(),
                    metadata: buildMetadata(context?.metadata, {
                        provider: AIProvider.Mistral,
                        model,
                        status: "incomplete",
                        requestId: context?.requestId
                    })
                };
            }

            const finalOutput = this.normalizeAnalyses(
                parseBestEffortJson<MistralImageAnalysisPayload>(accumulatedText),
                images
            );
            const finalEmissionSignature = JSON.stringify(finalOutput.map(({ id: _id, ...analysis }) => analysis));
            // If the final normalized state is identical to the last incremental emission,
            // keep the terminal chunk authoritative via `output` but avoid repeating it in `delta`.
            const finalDelta = finalEmissionSignature === lastEmissionSignature ? [] : finalOutput;

            yield {
                delta: finalDelta,
                output: finalOutput,
                done: true,
                id: responseId ?? crypto.randomUUID(),
                metadata: buildMetadata(context?.metadata, {
                    provider: AIProvider.Mistral,
                    model,
                    status: "completed",
                    requestId: context?.requestId
                })
            };
        } catch (err) {
            if (signal?.aborted) {
                return;
            }

            yield {
                delta: [],
                output: [],
                done: true,
                id: responseId ?? crypto.randomUUID(),
                metadata: buildMetadata(context?.metadata, {
                    provider: AIProvider.Mistral,
                    model,
                    status: "error",
                    requestId: context?.requestId,
                    error: err instanceof Error ? err.message : String(err)
                })
            };
        }
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
            // Mistral multimodal chat accepts either remote URLs or data URIs for image parts.
            content.push({
                type: "image_url",
                imageUrl: resolveReferenceMediaUrl(
                    image,
                    "image/png",
                    "Mistral image analysis requires image.base64 or image.url"
                )
            });
        }
        return content;
    }

    /**
     * Flattens Mistral assistant content into plain text for JSON parsing.
     *
     * Mistral chat content may arrive as either a raw string or an array of typed
     * content chunks, including during streaming delta events.
     *
     * @param {string | Array<ContentChunk> | null | undefined} content Provider message content.
     * @returns {string} Flattened text content.
     */
    private extractMessageText(content: string | Array<ContentChunk> | null | undefined): string {
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
        const structuredPayloads = payload.filter(
            (item): item is MistralImageAnalysisPayload => !!item && typeof item === "object"
        );
        if (structuredPayloads.length === 0) {
            const fallbackDescription = typeof payload[0] === "string" ? payload[0] : undefined;

            return images.map((image, index) => ({
                id: crypto.randomUUID(),
                // If parsing never yields an object, preserve the first raw text response
                // as a best-effort description for the first source image.
                description: index === 0 ? fallbackDescription : undefined,
                sourceImageId: image.id
            }));
        }

        return structuredPayloads.map((item, index) => {
            const normalizedObjects = item.objects
                ?.filter((obj) => typeof obj?.label === "string" && obj.label.length > 0)
                .map((obj) => ({ label: obj.label! }));
            const normalizedText = item.text
                ?.filter((entry) => typeof entry?.text === "string" && entry.text.length > 0)
                .map((entry) => ({ text: entry.text!, confidence: entry.confidence }));
            const normalizedSafety = item.safety
                ? {
                      flagged: Boolean(item.safety.flagged),
                      categories: item.safety.categories
                  }
                : undefined;
            // Prefer the provider's explicit image index when present, then fall back
            // to the current payload position so output can still be matched to input images.
            const sourceImageId = images[item.imageIndex ?? index]?.id ?? images[index]?.id;

            return {
                id: crypto.randomUUID(),
                description: item.description,
                tags: item.tags,
                objects: normalizedObjects,
                text: normalizedText,
                safety: normalizedSafety,
                sourceImageId
            };
        });
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
        return (
            images
                // Ignore context images that have no reusable provider-facing source.
                .filter((image) => image.url || image.base64)
                .map((image) => ({
                    id: image.id,
                    sourceType: image.url ? "url" : "base64",
                    url: image.url,
                    base64: image.base64,
                    mimeType: image.mimeType
                }))
        );
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
            ...(modelParams ?? {}),
            model,
            messages: [userMessage],
            // Mistral does not expose OpenAI-style tool schemas here, so JSON output is
            // steered through prompt design plus the provider's `json_object` response format.
            responseFormat: { type: "json_object" }
        } as ChatCompletionRequest;
    }
}
