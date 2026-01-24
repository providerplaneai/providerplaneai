import { GoogleGenAI } from "@google/genai";
import {
    AIProvider,
    AIRequest,
    AIResponse,
    BaseProvider,
    CapabilityKeys,
    ClientImageGenerationRequest,
    ClientReferenceImage,
    ImageGenerationCapability,
    MultiModalExecutionContext,
    NormalizedImage,
    resolveImageToBytes
} from "#root/index.js";

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
 * GeminiImageGenerationCapabilityImpl: Implements image generation for Gemini / Imagen 4.
 *
 * Responsibilities:
 * - Converts prompts and optional reference images into Imagen 4 API calls
 * - Handles aspect ratio mapping, reference weight, and prompt tagging
 * - Returns normalized images with base64, mime type, and metadata
 *
 * @template TRequest - The client image generation request type
 */
export class GeminiImageGenerationCapabilityImpl implements ImageGenerationCapability<ClientImageGenerationRequest> {
    /**
     * Creates a new Gemini image generation capability.
     *
     * @param provider - Parent provider instance
     * @param client - Initialized Gemini / Imagen SDK client
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
     * @param request - Unified client image generation request
     * @param _executionContext Optional execution context
     * @returns `AIResponse<NormalizedImage[]>` with generated images
     * @throws Error if prompt is missing or generation fails
     */
    async generateImage(
        request: AIRequest<ClientImageGenerationRequest>,
        _executionContext?: MultiModalExecutionContext
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
                const bytes = await resolveImageToBytes(ref.url || ref.base64!);
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
        const finalPrompt = this.injectReferenceTags(input.prompt, referenceImages.length);

        // 3. Execute Imagen 4 Generation
        const response = await (this.client.models as any).generateImages({
            model: merged.model ?? "imagen-4.0-generate-001",
            prompt: finalPrompt,
            referenceImages: referenceImages.length > 0 ? referenceImages : undefined,
            config: {
                numberOfImages: input.params?.count ?? 1,
                aspectRatio: this.mapSizeToImagenAspectRatio(input.params?.size),
                includeRaiReason: true,
                // Apply weight from the primary reference if available
                referenceImageWeight: this.mapWeight(input.referenceImages?.[0]?.weight),
                // Safety setting for person generation
                personGeneration: "allow_adult"
            }
        });

        const responseId = `gen-${crypto.randomUUID()}`;

        // 4. Map and validate images
        const images: NormalizedImage[] = (response.generatedImages ?? []).map((genImg: any, idx: number) => {
            const imgData = genImg.image?.imageBytes || genImg.image?.bytesBase64Encoded;

            return {
                base64: typeof imgData === "string" ? imgData : Buffer.from(imgData).toString("base64"),
                url: undefined,
                mimeType: genImg.image?.mimeType ?? "image/png",
                raw: genImg,
                index: idx,
                id: `${responseId}-${idx}`
            };
        });

        // Normalize to AIResult
        return {
            output: images,
            rawResponse: response,
            id: responseId,
            metadata: {
                provider: AIProvider.Gemini,
                model: merged.model ?? "imagen-4.0-generate-001",
                status: "completed",
                requestId: context?.requestId,
                ...(context?.metadata ?? {})
            }
        };
    }

    /**
     * Maps a size string like "1536x1024" to the nearest Imagen canonical aspect ratio.
     *
     * Defaults to "1:1" if parsing fails or the size is invalid.
     *
     * @param size - Optional size string in the form "WIDTHxHEIGHT"
     * @returns Closest canonical Imagen aspect ratio
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
     * Ensures that `[id]` tags exist in the prompt to match reference images.
     *
     * Imagen 4 requires explicit [1], [2], ... tags for reference association.
     *
     * @param prompt - Original text prompt
     * @param refCount - Number of reference images
     * @returns Prompt with `[id]` tags injected
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
