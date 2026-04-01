/**
 * @module providers/anthropic/capabilities/AnthropicImageAnalysisCapabilityImpl.ts
 * @description Anthropic image-analysis capability adapter.
 */
import Anthropic from "@anthropic-ai/sdk";
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
    NormalizedImageAnalysis,
    resolveReferenceMediaSource,
    buildMetadata
} from "#root/index.js";

const DEFAULT_ANTHROPIC_VISION_PROMPT = `
Analyze EACH image independently.

Return a JSON array.
Each array element must describe exactly one image.
Include description, tags, safety, and identified objects for each image.
Do not merge images.
Use imageIndex based on the order provided.
`;
const DEFAULT_ANTHROPIC_IMAGE_ANALYSIS_MODEL = "claude-sonnet-4";

/**
 * Adapts Anthropic image analysis responses into ProviderPlaneAI's normalized image-analysis artifact surface.
 *
 * Supports non-streaming and streaming per-image analysis by prompting Claude to
 * return JSON which is then normalized into `NormalizedImageAnalysis[]`.
 *
 * @public
 */
export class AnthropicImageAnalysisCapabilityImpl
    implements ImageAnalysisCapability<ClientImageAnalysisRequest>, ImageAnalysisStreamCapability<ClientImageAnalysisRequest>
{
    /**
     * Creates a new Anthropic image analysis capability adapter.
     *
     * @param {BaseProvider} provider Provider lifecycle and config access.
     * @param {Anthropic} client Initialized Anthropic SDK client.
     */
    constructor(
        private readonly provider: BaseProvider,
        private readonly client: Anthropic
    ) {}

    /**
     * Runs non-streaming image analysis.
     *
     * Each input image is analyzed independently to keep parsing isolated and
     * avoid cross-image output coupling.
     *
     * @param {AIRequest<ClientImageAnalysisRequest>} request - Provider-agnostic image-analysis request envelope.
     * @param {MultiModalExecutionContext | undefined} _executionContext - Optional execution context.
     * @param {AbortSignal | undefined} signal - Optional abort signal.
     * @returns {Promise<AIResponse<NormalizedImageAnalysis[]>>} Normalized analysis artifacts for all requested images.
     * @throws {Error} If no images are provided or execution is aborted.
     */
    async analyzeImage(
        request: AIRequest<ClientImageAnalysisRequest>,
        _executionContext?: MultiModalExecutionContext,
        signal?: AbortSignal
    ): Promise<AIResponse<NormalizedImageAnalysis[]>> {
        this.provider.ensureInitialized();
        if (signal?.aborted) {
            throw new Error("Image analysis aborted before request started");
        }

        const { input, options, context } = request;
        const images = input.images ?? [];
        if (!images.length) {
            throw new Error("At least one image is required for analysis");
        }

        const merged = this.provider.getMergedOptions(CapabilityKeys.ImageAnalysisCapabilityKey, options);
        const promptText =
            input.prompt ??
            (typeof merged.generalParams?.defaultPrompt === "string" && merged.generalParams.defaultPrompt.trim().length > 0
                ? merged.generalParams.defaultPrompt
                : DEFAULT_ANTHROPIC_VISION_PROMPT);

        const results: NormalizedImageAnalysis[] = [];

        // Analyze images sequentially so one malformed output does not contaminate others.
        for (const image of images) {
            if (signal?.aborted) {
                break;
            }

            const response = await this.client.messages.create(
                {
                    model: merged.model ?? DEFAULT_ANTHROPIC_IMAGE_ANALYSIS_MODEL,
                    max_tokens: merged.modelParams?.max_tokens ?? 1024,
                    messages: this.buildVisionMessages(promptText, [image]),
                    ...merged.modelParams,
                    ...merged.providerParams
                },
                { signal }
            );

            const text = this.extractText(response);
            // Provider may wrap JSON in markdown fences; strip before parsing.
            const parsed = this.normalizeAnalyses(this.stripJsonFences(text), image.id);

            results.push(...parsed);
        }

        return {
            output: results,
            rawResponse: null, // multiple underlying responses
            id: context?.requestId ?? crypto.randomUUID(),
            metadata: buildMetadata(context?.metadata, {
                provider: AIProvider.Anthropic,
                model: merged.model,
                status: "completed",
                requestId: context?.requestId
            })
        };
    }

    /**
     * Streams image analysis output.
     *
     * Emits partial deltas while text is streaming, then a terminal chunk with
     * final normalized analysis for each image.
     *
     * @param {AIRequest<ClientImageAnalysisRequest>} request - Provider-agnostic image-analysis request envelope.
     * @param {MultiModalExecutionContext | undefined} _executionContext - Optional execution context.
     * @param {AbortSignal | undefined} signal - Optional abort signal.
     * @returns {AsyncGenerator<AIResponseChunk<NormalizedImageAnalysis[]>>} Async generator of normalized image-analysis chunks.
     * @throws {Error} If no images are provided.
     */
    async *analyzeImageStream(
        request: AIRequest<ClientImageAnalysisRequest>,
        _executionContext?: MultiModalExecutionContext,
        signal?: AbortSignal
    ): AsyncGenerator<AIResponseChunk<NormalizedImageAnalysis[]>> {
        this.provider.ensureInitialized();

        const { input, options, context } = request;
        const images = input.images ?? [];
        if (!images.length) {
            throw new Error("At least one image is required for analysis");
        }

        const merged = this.provider.getMergedOptions(CapabilityKeys.ImageAnalysisStreamCapabilityKey, options);
        const promptText =
            input.prompt ??
            (typeof merged.generalParams?.defaultPrompt === "string" && merged.generalParams.defaultPrompt.trim().length > 0
                ? merged.generalParams.defaultPrompt
                : DEFAULT_ANTHROPIC_VISION_PROMPT);

        // Stream each image independently to preserve image-level boundaries.
        for (const image of images) {
            if (signal?.aborted) {
                return;
            }

            let responseId: string | undefined;
            let accumulatedText = "";

            try {
                const stream = await this.client.messages.stream(
                    {
                        model: merged.model ?? DEFAULT_ANTHROPIC_IMAGE_ANALYSIS_MODEL,
                        max_tokens: merged.modelParams?.max_tokens ?? 1024,
                        messages: this.buildVisionMessages(promptText, [image]),
                        ...merged.modelParams,
                        ...merged.providerParams
                    },
                    { signal }
                );

                for await (const event of stream) {
                    if (signal?.aborted) {
                        return;
                    }

                    if (event.type === "message_start") {
                        responseId ??= event.message?.id;
                    }

                    if (event.type === "content_block_delta" && event.delta?.type === "text_delta") {
                        accumulatedText += event.delta.text;

                        // Emit partial text delta plus best-effort normalized output so
                        // subscribers can progressively render analysis.
                        yield {
                            delta: [
                                {
                                    id: responseId ?? crypto.randomUUID(),
                                    description: event.delta.text,
                                    sourceImageId: image.id
                                }
                            ],
                            output: this.normalizeAnalyses(this.stripJsonFences(accumulatedText), image.id),
                            done: false,
                            id: responseId ?? crypto.randomUUID(),
                            metadata: buildMetadata(context?.metadata, {
                                provider: AIProvider.Anthropic,
                                model: merged.model,
                                status: "incomplete",
                                requestId: context?.requestId
                            })
                        };
                    }
                }

                // Emit one final normalized result for the current image.
                const analyses = this.normalizeAnalyses(this.stripJsonFences(accumulatedText), image.id);

                yield {
                    delta: [],
                    output: analyses,
                    done: true,
                    id: responseId ?? crypto.randomUUID(),
                    metadata: buildMetadata(context?.metadata, {
                        provider: AIProvider.Anthropic,
                        model: merged.model,
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
                        provider: AIProvider.Anthropic,
                        model: merged.model,
                        status: "error",
                        requestId: context?.requestId,
                        error: err instanceof Error ? err.message : String(err),
                        sourceImageId: image.id
                    })
                };
            }
        }
    }

    /**
     * Normalizes provider JSON (or JSON-like text) into stable `NormalizedImageAnalysis[]`.
     *
     * @param {unknown} payload Raw provider payload or JSON text.
     * @param {string | undefined} sourceImageId Optional source image id propagated into normalized artifacts.
     * @returns {NormalizedImageAnalysis[]} Normalized image analysis artifacts. Returns an empty array on parse failure.
     */
    private normalizeAnalyses(payload: string | unknown, sourceImageId?: string): NormalizedImageAnalysis[] {
        let root: any;

        if (typeof payload === "string") {
            try {
                root = JSON.parse(payload);
            } catch {
                return [];
            }
        } else {
            root = payload;
        }

        if (!root) {
            return [];
        }

        const items = Array.isArray(root) ? root : [root];

        return items.map((item: any) => {
            // 1) Description: prefer explicit field; otherwise pick first useful string.
            let description = item.description;
            if (!description || typeof description !== "string") {
                const strings: string[] = [];
                const walk = (v: unknown) => {
                    if (typeof v === "string" && v.trim()) {
                        strings.push(v.trim());
                    } else if (Array.isArray(v)) {
                        v.forEach(walk);
                    } else if (v && typeof v === "object") {
                        Object.values(v).forEach(walk);
                    }
                };
                walk(item);
                description = strings.shift() ?? undefined;
            }

            // 2) Tags: prefer explicit tags array, then infer from other arrays/description.
            let tags: string[] | undefined;

            if (Array.isArray(item.tags) && item.tags.length > 0) {
                tags = item.tags.filter((t: unknown): t is string => typeof t === "string" && t.trim().length > 0);
            }

            // Fallback: derive tags from any other arrays in the object
            if (!tags || tags.length === 0) {
                tags = [];
                Object.values(item).forEach((v: unknown) => {
                    if (Array.isArray(v)) {
                        v.forEach((e: unknown) => {
                            if (typeof e === "string" && e.trim().length > 3 && e.trim().length < 40) {
                                tags!.push(e.trim());
                            }
                        });
                    }
                });
            }

            // Final fallback: derive short phrases from description.
            if (!tags || tags.length === 0) {
                if (typeof description === "string") {
                    tags = Array.from(
                        new Set(
                            description
                                .split(/[,.;]/)
                                .map((s) => s.trim())
                                .filter((s) => s.length > 3 && s.length < 40)
                        )
                    );
                }
            }

            // 3) Objects: preserve provider objects when available, else mirror inferred tags.
            let objects: { label: string }[] | undefined;
            if (Array.isArray(item.objects) && item.objects.length > 0) {
                objects = item.objects
                    .filter((o: any) => o && typeof o.label === "string")
                    .map((o: any) => ({ label: o.label }));
            } else if (tags && tags.length > 0) {
                objects = tags.map((t) => ({ label: t }));
            }
            return {
                id: crypto.randomUUID(),
                sourceImageId,
                description,
                tags: tags?.length ? tags : undefined,
                objects: objects?.length ? objects : undefined,
                safety: { flagged: item.safety !== "safe" }
            };
        });
    }

    /**
     * Extracts plain text blocks from an Anthropic message response.
     *
     * @param {Anthropic.Messages.Message} message Anthropic message payload.
     * @returns {string} Concatenated text content.
     */
    private extractText(message: any): string {
        return (message?.content ?? [])
            .filter((c: any) => c.type === "text")
            .map((c: any) => c.text)
            .join("");
    }

    /**
     * Builds Anthropic vision message payload for one or more base64 images.
     *
     * @param {string} prompt Required vision instruction prompt.
     * @param {ClientReferenceImage[]} images Input images to include in message content.
     * @returns {any[]} Anthropic messages array.
     * @throws {Error} If the prompt is empty or an image source cannot be normalized for Anthropic.
     */
    private buildVisionMessages(prompt: string, images: ClientReferenceImage[]): any[] {
        if (!prompt) {
            throw new Error("Vision prompt is required");
        }

        const content: any[] = [];

        // Prompt goes first so model has instruction context before media blocks.
        content.push({ type: "text", text: prompt });

        for (const img of images) {
            const resolved = resolveReferenceMediaSource(img, "image/png", "Anthropic vision requires base64 images");
            if (resolved.kind !== "base64") {
                throw new Error(`Anthropic vision requires base64 images (got ${img.sourceType})`);
            }

            if (img.description) {
                // Optional per-image hint can improve specificity for ambiguous visuals.
                content.push({ type: "text", text: img.description });
            }

            content.push({
                type: "image",
                source: { type: "base64", media_type: resolved.mimeType, data: resolved.base64 }
            });
        }

        return [{ role: "user", content }];
    }

    /**
     * Removes surrounding markdown code fences from JSON-like model output.
     *
     * @param {string} text Raw model text.
     * @returns {string} Unfenced text suitable for JSON parsing.
     */
    private stripJsonFences(text: string): string {
        const trimmed = text.trim();
        if (trimmed.startsWith("```") && trimmed.endsWith("```")) {
            return trimmed
                .replace(/^```(?:json)?\s*/i, "")
                .replace(/\s*```$/, "")
                .trim();
        }
        return trimmed;
    }
}
