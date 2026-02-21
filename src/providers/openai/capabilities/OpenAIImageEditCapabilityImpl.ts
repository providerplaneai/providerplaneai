import OpenAI from "openai";
import {
    AIProvider,
    AIRequest,
    AIResponse,
    AIResponseChunk,
    BaseProvider,
    CapabilityKeys,
    ClientImageEditRequest,
    ClientReferenceImage,
    ensureDataUri,
    ImageEditCapability,
    ImageEditStreamCapability,
    MultiModalExecutionContext,
    NormalizedImage,
    NormalizedMask
} from "#root/index.js";

/**
 * OpenAIImageEditCapabilityImpl: Implements provider-agnostic image editing using OpenAI.
 *
 * Supports:
 * - Non-streaming and streaming image edits
 * - Multi-turn history
 * - Automatic and manual masks
 * - Normalized outputs for images and masks
 */
export class OpenAIImageEditCapabilityImpl
    implements ImageEditCapability<ClientImageEditRequest>, ImageEditStreamCapability<ClientImageEditRequest>
{
    constructor(
        private readonly provider: BaseProvider,
        private readonly client: OpenAI
    ) {}

    /**
     * Non-streaming image edit.
     *
     * @param request - Client image edit request
     * @param executionContext - Timeline & context tracking
     * @param signal - Optional abort signal
     * @returns Normalized images and masks
     */
    async editImage(
        request: AIRequest<ClientImageEditRequest>,
        executionContext: MultiModalExecutionContext,
        signal?: AbortSignal
    ): Promise<AIResponse<NormalizedImage[]>> {
        this.provider.ensureInitialized();

        const { input, options, context } = request;
        if (!input?.prompt) {
            throw new Error("Edit prompt is required for image editing");
        }
        if (signal?.aborted) {
            throw new Error("Image editing aborted before request started");
        }

        const merged = this.provider.getMergedOptions(CapabilityKeys.ImageEditCapabilityKey, options);
        const { content, masks: rawMasks } = await this.prepareEditContent(input, executionContext);

        const response = await this.client.responses.create(
            {
                model: merged.model ?? "gpt-4.1",
                input: [{ role: "user", content }],
                tools: [
                    {
                        type: "image_generation",
                        size: input.params?.size,
                        quality: input.params?.quality,
                        style: input.params?.style,
                        background: input.params?.background
                    }
                ],
                ...(merged.modelParams ?? {}),
                ...(merged.providerParams ?? {})
            },
            { signal }
        );

        let imageIndex = 0;
        const images: NormalizedImage[] = [];
        for (const item of response.output ?? []) {
            const normalized = this.normalizeEditedImages(item, imageIndex);
            imageIndex += normalized.length;
            images.push(...normalized);
        }

        const masks = this.normalizeEditedMasks(rawMasks);

        return {
            output: images,
            multimodalArtifacts: { images, masks },
            rawResponse: response,
            id: response.id ?? crypto.randomUUID(),
            metadata: {
                ...(context?.metadata ?? {}),
                provider: AIProvider.OpenAI,
                model: merged.model ?? "gpt-4.1",
                status: "completed",
                requestId: context?.requestId
            }
        };
    }

    /**
     * Streaming image edit.
     *
     * Images are yielded incrementally as they complete.
     * Masks are yielded ONCE (with the first image chunk) since they
     * represent input context, not generated outputs.
     */
    async *editImageStream(
        request: AIRequest<ClientImageEditRequest>,
        executionContext: MultiModalExecutionContext,
        signal?: AbortSignal
    ): AsyncGenerator<AIResponseChunk<NormalizedImage[]>> {
        this.provider.ensureInitialized();

        const { input, options, context } = request;
        if (!input?.prompt) {
            throw new Error("Edit prompt is required for image editing");
        }

        const merged = this.provider.getMergedOptions(CapabilityKeys.ImageEditCapabilityKey, options);
        let responseId: string | undefined;
        let imageIndex = 0;
        let masksYielded = false;

        try {
            const { content, masks: rawMasks } = await this.prepareEditContent(input, executionContext);
            const masks = this.normalizeEditedMasks(rawMasks);

            const stream = this.client.responses.stream(
                {
                    model: merged.model ?? "gpt-4.1",
                    input: [{ role: "user", content }],
                    tools: [
                        {
                            type: "image_generation",
                            size: input.params?.size,
                            quality: input.params?.quality,
                            style: input.params?.style,
                            background: input.params?.background
                        }
                    ],
                    ...(merged.modelParams ?? {}),
                    ...(merged.providerParams ?? {})
                },
                { signal }
            );

            for await (const event of stream) {
                if (signal?.aborted) {
                    throw new Error("Image editing aborted during streaming");
                }

                if (!responseId && event.type === "response.created" && "response" in event && event.response?.id) {
                    responseId = event.response.id;
                }

                if (event.type !== "response.completed") {
                    continue;
                }

                const outputItems = event.response.output ?? [];
                const newImages: NormalizedImage[] = [];

                for (const item of outputItems) {
                    const images = this.normalizeEditedImages(item, imageIndex);
                    if (!images.length) {
                        continue;
                    }
                    imageIndex += images.length;
                    newImages.push(...images);
                }

                if (!newImages.length) {
                    continue;
                }

                yield {
                    delta: newImages,
                    output: newImages,
                    done: false,
                    id: responseId,
                    multimodalArtifacts: masksYielded ? { images: newImages } : { images: newImages, masks },
                    metadata: {
                        ...(context?.metadata ?? {}),
                        provider: AIProvider.OpenAI,
                        model: merged.model ?? "gpt-4.1",
                        status: "incomplete",
                        requestId: context?.requestId
                    }
                };

                if (!masksYielded) {
                    masksYielded = true;
                }
            }

            yield {
                delta: [],
                output: [],
                done: true,
                id: responseId,
                metadata: {
                    ...(context?.metadata ?? {}),
                    provider: AIProvider.OpenAI,
                    model: merged.model ?? "gpt-4.1",
                    status: "completed",
                    requestId: context?.requestId
                }
            };
        } catch (err) {
            if (signal?.aborted) {
                return;
            }

            yield {
                output: [],
                delta: [],
                done: true,
                id: "",
                error: err instanceof Error ? err.message : String(err),
                metadata: {
                    ...(context?.metadata ?? {}),
                    provider: AIProvider.OpenAI,
                    model: merged.model ?? "gpt-4.1",
                    status: "error",
                    requestId: context?.requestId
                }
            };
        }
    }

    /**
     * Prepares the input content array for OpenAI image edit calls.
     *
     * Order matters:
     * 1. Subject image (required)
     * 2. Mask images (optional)
     * 3. Reference images (optional)
     * 4. Prompt text
     *
     * Masks are passed as images but semantically interpreted by the model.
     */
    private prepareEditContent(
        input: ClientImageEditRequest,
        executionContext: MultiModalExecutionContext
    ): { content: any[]; masks: ClientReferenceImage[] } {
        const content: any[] = [];
        const timelineImages = executionContext.getTimeline().flatMap((t) => t.artifacts?.images ?? []);

        let baseImage: ClientReferenceImage | undefined = input.referenceImages?.find((i) => i.role === "subject");
        if (!baseImage && timelineImages.length) {
            const last = timelineImages[timelineImages.length - 1];
            baseImage = {
                id: last.id,
                base64: last.base64,
                url: last.url,
                mimeType: last.mimeType,
                role: "subject",
                sourceType: "base64"
            };
        }

        if (!baseImage) {
            throw new Error("Image edit requires a subject image");
        }

        content.push({
            type: "input_image",
            image_url: ensureDataUri(baseImage.url ?? baseImage.base64!, baseImage.mimeType)
        });

        const masks = input.referenceImages?.filter((i) => i.role === "mask") ?? [];
        for (const mask of masks) {
            content.push({
                type: "input_image",
                image_url: ensureDataUri(mask.url ?? mask.base64!, mask.mimeType)
            });
        }

        const extraRefs = input.referenceImages?.filter((i) => i.role === "reference") ?? [];
        for (const ref of extraRefs) {
            if (ref.url || ref.base64) {
                content.push({
                    type: "input_image",
                    image_url: ensureDataUri(ref.url ?? ref.base64!, ref.mimeType)
                });
            }
        }

        content.push({ type: "input_text", text: input.prompt });

        return { content, masks };
    }

    /**
     * Normalize base64 images from the provider into standardized objects.
     */
    private normalizeEditedImages(item: any, startIndex: number): NormalizedImage[] {
        if (!item || item.type !== "image_generation_call") {
            return [];
        }

        const images: NormalizedImage[] = [];
        let index = startIndex;

        if (typeof item.result === "string") {
            images.push({
                id: item.id,
                base64: item.result,
                url: ensureDataUri(item.result, "image/png"),
                mimeType: "image/png",
                index: index++,
                raw: item
            });
        } else if (Array.isArray(item.result)) {
            for (const b64 of item.result) {
                if (typeof b64 !== "string") {
                    continue;
                }
                images.push({
                    id: item.id,
                    base64: b64,
                    url: ensureDataUri(b64, "image/png"),
                    mimeType: "image/png",
                    index: index++,
                    raw: item
                });
            }
        }

        return images;
    }

    /**
     * Normalizes mask reference images into provider-agnostic mask artifacts.
     *
     * IMPORTANT:
     * - OpenAI does NOT return masks as outputs.
     * - Masks are treated as INPUT artifacts used during the edit operation.
     * - These normalized masks exist solely for downstream consumers
     *   (UI overlays, debugging, provenance tracking).
     *
     * `targetImageId` optionally associates the mask with a specific
     * output image when multiple images are generated.
     */
    private normalizeEditedMasks(masks: ClientReferenceImage[]): NormalizedMask[] {
        return masks.map((m) => ({
            id: m.id,
            base64: m.base64,
            url: m.url,
            // Narrow unknown → string | undefined for type safety
            targetImageId: typeof m.extras?.targetImageId === "string" ? m.extras.targetImageId : undefined,
            mimeType: m.mimeType,
            role: "mask",
            // Mask semantic type (used by UIs / renderers, not the provider)
            kind: m.extras?.kind as "alpha" | "binary" | "grayscale" | undefined
        }));
    }
}
