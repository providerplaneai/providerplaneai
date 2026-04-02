/**
 * @module providers/gemini/capabilities/GeminiImageGenerationCapabilityImpl.ts
 * @description Gemini image generation capability adapter.
 */
import { GenerateImagesResponse, GoogleGenAI } from "@google/genai";
import {
    AIProvider,
    AIRequest,
    AIResponse,
    AIResponseChunk,
    BaseProvider,
    CapabilityKeys,
    ClientImageGenerationRequest,
    ClientReferenceImage,
    ensureDataUri,
    ImageGenerationCapability,
    ImageGenerationStreamCapability,
    MultiModalExecutionContext,
    NormalizedImage,
    resolveReferenceMediaUrl,
    resolveImageToBytes,
    buildMetadata
} from "#root/index.js";

const DEFAULT_GEMINI_IMAGE_GENERATION_MODEL = "imagen-4.0-generate-001";

/**
 * Canonical aspect ratios supported by Imagen4
 */
const IMAGEN_ASPECT_RATIOS = [
    { label: "1:1", value: 1 },
    { label: "3:4", value: 3 / 4 },
    { label: "4:3", value: 4 / 3 },
    { label: "9:16", value: 9 / 16 },
    { label: "16:9", value: 16 / 9 }
] as const;

type ImagenAspectRatio = "1:1" | "3:4" | "4:3" | "16:9" | "9:16";

type ImagenAspectRatioEntry = (typeof IMAGEN_ASPECT_RATIOS)[number];

/**
 * Adapts Gemini / Imagen image generation responses into ProviderPlaneAI's normalized image artifact surface.
 *
 * Handles prompt shaping, reference image conversion, aspect-ratio mapping, and
 * normalized image artifact construction for both non-streaming and streaming flows.
 *
 * @public
 */
export class GeminiImageGenerationCapabilityImpl
    implements
        ImageGenerationCapability<ClientImageGenerationRequest>,
        ImageGenerationStreamCapability<ClientImageGenerationRequest>
{
    /**
     * Creates a new Gemini image generation capability adapter.
     *
     * @param {BaseProvider} provider Owning provider instance used for initialization checks and merged config access.
     * @param {GoogleGenAI} client Initialized Gemini / Imagen SDK client.
     */
    constructor(
        private readonly provider: BaseProvider,
        private readonly client: GoogleGenAI
    ) {}

    /**
     * Generates images using Gemini / Imagen 4 API.
     *
     * Responsibilities:
     * - Resolves reference images to bytes
     * - Adjusts prompt for reference IDs
     * - Calls Imagen 4 generateImages endpoint
     * - Normalizes output into `NormalizedImage[]`
     *
     * @param {AIRequest<ClientImageGenerationRequest>} request Unified image generation request envelope.
     * @param {MultiModalExecutionContext} [_executionContext] Optional multimodal execution context. Unused directly in this adapter.
     * @param {AbortSignal} [signal] Optional cancellation signal.
     * @returns {Promise<AIResponse<NormalizedImage[]>>} Provider-normalized generated image artifacts.
     * @throws {Error} If the prompt is missing or Gemini returns no image artifacts.
     */
    async generateImage(
        request: AIRequest<ClientImageGenerationRequest>,
        _executionContext?: MultiModalExecutionContext,
        signal?: AbortSignal
    ): Promise<AIResponse<NormalizedImage[]>> {
        // Ensure provider has been initialized with credentials + client
        this.provider.ensureInitialized();

        const { input, options, context } = request;

        // Defensive guards against empty prompt
        if (!input?.prompt) {
            throw new Error("Prompt is required for image generation.");
        }

        // Merge general, provider, model, and request-level options
        const merged = this.provider.getMergedOptions(CapabilityKeys.ImageGenerationCapabilityKey, options);

        // 1. Resolve and Format Reference Images
        const referenceImages = await Promise.all(
            (input.referenceImages ?? []).map(async (ref: ClientReferenceImage, idx: number) => {
                const bytes = await resolveImageToBytes(
                    resolveReferenceMediaUrl(ref, "image/png", "referenceImage must include url or base64")
                );
                const refId = idx + 1;

                return {
                    referenceId: refId,
                    // Map 'role' to Imagen 4 referenceType enums
                    referenceType: ref.role === "style" ? "REFERENCE_TYPE_STYLE" : "REFERENCE_TYPE_SUBJECT",
                    referenceImage: {
                        bytes: new Uint8Array(bytes),
                        mimeType: ref.mimeType || "image/png"
                    }
                };
            })
        );

        // 2. Adjust the prompt to use the Reference IDs
        // Imagen binds references by explicit [n] tags; inject missing tags to
        // keep behavior deterministic even with plain-language prompts.
        const finalPrompt = this.injectReferenceTags(input.prompt, referenceImages.length);

        if (signal?.aborted) {
            throw new Error("Image generation aborted before API call");
        }

        // 3. Execute Imagen 4 Generation
        const response = (await (this.client.models as any).generateImages({
            model: merged.model ?? DEFAULT_GEMINI_IMAGE_GENERATION_MODEL,
            prompt: finalPrompt,
            referenceImages: referenceImages.length > 0 ? referenceImages : undefined,
            config: {
                aspectRatio: this.mapSizeToImagenAspectRatio(input.params?.size),
                includeRaiReason: true,
                // Apply weight from the primary reference if available
                referenceImageWeight: this.mapWeight(input.referenceImages?.[0]?.weight),
                // Safety setting for person generation
                personGeneration: "allow_adult",
                numberOfImages: this.resolveNumberOfImages(input)
            }
        })) as GenerateImagesResponse;

        if (signal?.aborted) {
            throw new Error("Image generation aborted after API call");
        }

        const responseId = `gen-${crypto.randomUUID()}`;

        // 4. Map and validate images
        const images: NormalizedImage[] = (response.generatedImages ?? []).map((genImg: any, idx: number) => {
            const imgData = genImg.image?.imageBytes || genImg.image?.bytesBase64Encoded;
            const base64 = typeof imgData === "string" ? imgData : Buffer.from(imgData).toString("base64");

            return {
                base64,
                url: ensureDataUri(base64, genImg.image?.mimeType ?? "image/png"),
                mimeType: genImg.image?.mimeType ?? "image/png",
                raw: genImg,
                index: idx,
                id: `${responseId}-${idx}`
            };
        });
        if (images.length === 0) {
            throw new Error("Gemini image generation returned no image artifacts");
        }

        // Normalize to AIResult
        return {
            output: images,
            rawResponse: response,
            id: responseId,
            metadata: buildMetadata(context?.metadata, {
                provider: AIProvider.Gemini,
                model: merged.model ?? DEFAULT_GEMINI_IMAGE_GENERATION_MODEL,
                status: "completed",
                requestId: context?.requestId
            })
        };
    }

    /**
     * Streaming image generation for Gemini / Imagen 4.
     *
     * Emits exactly one chunk when the images are ready, similar to OpenAI streaming.
     */
    async *generateImageStream(
        request: AIRequest<ClientImageGenerationRequest>,
        _executionContext?: MultiModalExecutionContext,
        signal?: AbortSignal
    ): AsyncGenerator<AIResponseChunk<NormalizedImage[]>> {
        this.provider.ensureInitialized();

        const { input, options, context } = request;
        if (!input?.prompt) {
            throw new Error("Prompt is required for image generation");
        }

        const merged = this.provider.getMergedOptions(CapabilityKeys.ImageGenerationStreamCapabilityKey, options);

        let responseId: string | undefined;

        try {
            // Resolve reference images
            const referenceImages = await Promise.all(
                (input.referenceImages ?? []).map(async (ref: ClientReferenceImage, idx: number) => {
                    const bytes = await resolveImageToBytes(
                        resolveReferenceMediaUrl(ref, "image/png", "referenceImage must include url or base64")
                    );
                    const refId = idx + 1;

                    return {
                        referenceId: refId,
                        referenceType: ref.role === "style" ? "REFERENCE_TYPE_STYLE" : "REFERENCE_TYPE_SUBJECT",
                        referenceImage: {
                            bytes: new Uint8Array(bytes),
                            mimeType: ref.mimeType || "image/png"
                        }
                    };
                })
            );

            const finalPrompt = this.injectReferenceTags(input.prompt, referenceImages.length);

            if (signal?.aborted) {
                throw new Error("Image generation aborted before API call");
            }

            // Execute generation
            const response = (await (this.client.models as any).generateImages({
                model: merged.model ?? DEFAULT_GEMINI_IMAGE_GENERATION_MODEL,
                prompt: finalPrompt,
                referenceImages: referenceImages.length > 0 ? referenceImages : undefined,
                config: {
                    aspectRatio: this.mapSizeToImagenAspectRatio(input.params?.size),
                    includeRaiReason: true,
                    referenceImageWeight: this.mapWeight(input.referenceImages?.[0]?.weight),
                    personGeneration: "allow_adult",
                    numberOfImages: this.resolveNumberOfImages(input)
                }
            })) as GenerateImagesResponse;

            if (signal?.aborted) {
                throw new Error("Image generation aborted after API call");
            }

            responseId = `gen-${crypto.randomUUID()}`;

            // Normalize images
            const images: NormalizedImage[] = (response.generatedImages ?? []).map((genImg: any, idx: number) => {
                const imgData = genImg.image?.imageBytes || genImg.image?.bytesBase64Encoded;
                const base64 = typeof imgData === "string" ? imgData : Buffer.from(imgData).toString("base64");

                return {
                    base64,
                    url: ensureDataUri(base64, genImg.image?.mimeType ?? "image/png"),
                    mimeType: genImg.image?.mimeType ?? "image/png",
                    raw: genImg,
                    index: idx,
                    id: `${responseId}-${idx}`
                };
            });

            // Yield a single chunk for all images
            // Imagen currently returns the complete set at once, so stream mode
            // is represented as one terminal chunk for API parity.
            yield {
                output: images,
                delta: images,
                done: true,
                id: responseId,
                metadata: buildMetadata(context?.metadata, {
                    provider: AIProvider.Gemini,
                    model: merged.model ?? DEFAULT_GEMINI_IMAGE_GENERATION_MODEL,
                    status: "completed",
                    requestId: context?.requestId
                })
            };
        } catch (err) {
            if (signal?.aborted) {
                return;
            }

            yield {
                output: [],
                delta: [],
                done: true,
                id: responseId ?? crypto.randomUUID(),
                metadata: buildMetadata(context?.metadata, {
                    provider: AIProvider.Gemini,
                    model: merged.model ?? DEFAULT_GEMINI_IMAGE_GENERATION_MODEL,
                    status: "error",
                    requestId: context?.requestId,
                    error: err instanceof Error ? err.message : String(err)
                })
            };
        }
    }

    /**
     * Maps a size string like "1536x1024" to the nearest Imagen canonical aspect ratio.
     *
     * Defaults to "1:1" if parsing fails or the size is invalid.
     *
     * @param {string | undefined} size Optional size string in the form `WIDTHxHEIGHT`.
     * @returns {ImagenAspectRatio | undefined} Closest canonical Imagen aspect ratio.
     */
    private mapSizeToImagenAspectRatio(size?: string): ImagenAspectRatio {
        if (!size) {
            return "1:1";
        }

        // Already a valid ratio
        if (IMAGEN_ASPECT_RATIOS.some((r) => r.label === size)) {
            return size as ImagenAspectRatio;
        }

        // Parse WxH
        const match = size.match(/^(\d+)\s*x\s*(\d+)$/i);
        if (!match) {
            return "1:1";
        }

        const width = Number(match[1]);
        const height = Number(match[2]);

        if (!width || !height) {
            return "1:1";
        }

        const ratio = width / height;

        // Find nearest canonical ratio
        let closest: ImagenAspectRatioEntry = IMAGEN_ASPECT_RATIOS[0];
        let minDiff = Math.abs(ratio - closest.value);

        for (const candidate of IMAGEN_ASPECT_RATIOS) {
            const diff = Math.abs(ratio - candidate.value);
            if (diff < minDiff) {
                closest = candidate;
                minDiff = diff;
            }
        }

        return closest.label;
    }

    /**
     * Maps 0-1 weight to Imagen 4 semantic keywords
     */
    private mapWeight(weight?: number): "LOW" | "MEDIUM" | "HIGH" {
        if (weight === undefined || weight >= 0.7) {
            return "HIGH";
        }
        if (weight <= 0.3) {
            return "LOW";
        }

        return "MEDIUM";
    }

    /**
     * Resolves image count from provider-agnostic request extras.
     * Defaults to 1 to keep fallback behavior deterministic.
     */
    private resolveNumberOfImages(input: ClientImageGenerationRequest): number {
        const extras = input.params?.extras ?? {};
        const raw =
            (extras as Record<string, unknown>).numberOfImages ??
            (extras as Record<string, unknown>).numImages ??
            (extras as Record<string, unknown>).count;

        if (typeof raw !== "number" || !Number.isFinite(raw)) {
            return 1;
        }

        const normalized = Math.floor(raw);
        if (normalized < 1) {
            return 1;
        }
        if (normalized > 8) {
            return 8;
        }
        return normalized;
    }

    /**
     * Ensures that `[id]` tags exist in the prompt to match reference images.
     *
     * Imagen 4 requires explicit [1], [2], ... tags for reference association.
     *
     * @param {string} prompt Original text prompt.
     * @param {number} refCount Number of reference images.
     * @returns {string} Prompt with `[id]` tags injected.
     */
    private injectReferenceTags(prompt: string, refCount: number): string {
        let enhancedPrompt = prompt;
        for (let i = 1; i <= refCount; i++) {
            const tag = `[${i}]`;
            if (!enhancedPrompt.includes(tag)) {
                // Heuristic: Try to find a logical break or just append
                // In a production environment, you might use an NLP library here.
                enhancedPrompt += ` ${tag}`;
            }
        }
        return enhancedPrompt.trim();
    }
}
