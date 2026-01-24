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
    NormalizedImage
} from "#root/index.js";

/**
 * OpenAIImageEditCapabilityImpl: Implements image editing for OpenAI.
 *
 * Supports non-streaming and streaming edits, multi-turn history, automatic mask generation, and manual masking.
 */
export class OpenAIImageEditCapabilityImpl
    implements ImageEditCapability<ClientImageEditRequest>, ImageEditStreamCapability<ClientImageEditRequest>
{
    /**
     * Creates a new OpenAI image edit capability.
     *
     * @param provider - Parent provider instance for lifecycle/config access
     * @param executionContext Execution context
     * @param client - Initialized OpenAI SDK client
     */
    constructor(
        private readonly provider: BaseProvider,
        private readonly client: OpenAI
    ) {}

    /**
     * Non-streaming image edit.
     */
    async editImage(
        request: AIRequest<ClientImageEditRequest>,
        executionContext: MultiModalExecutionContext
    ): Promise<AIResponse<NormalizedImage[]>> {
        this.provider.ensureInitialized();

        const { input, options, context } = request;

        if (!input?.prompt) {
            throw new Error("Edit prompt is required for image editing");
        }

        // Merge general, provider, model, and request-level options
        const merged = this.provider.getMergedOptions(CapabilityKeys.ImageEditCapabilityKey, options);
        const count = input.params?.count ?? 1;

        // Prepare content and handle base/mask images
        const { content, masks } = await this.prepareEditContent(input, executionContext);

        // Generate multiple images concurrently
        const responses = await Promise.all(
            Array.from({ length: count }, () =>
                this.client.responses.create({
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
                })
            )
        );

        // Flatten output and normalize
        const images: NormalizedImage[] = [];
        for (let idx = 0; idx < responses.length; idx++) {
            const resp = responses[idx];
            const items = resp.output ?? [];
            for (const item of items) {
                if (item.type === "image_generation_call" && item.status === "completed" && typeof item.result === "string") {
                    const normalized: NormalizedImage = {
                        base64: item.result,
                        url: ensureDataUri(item.result, "image/png"),
                        mimeType: "image/png",
                        raw: item,
                        index: idx,
                        id: item.id
                    };
                    images.push(normalized);
                }
            }
        }

        return {
            output: images,
            multimodalArtifacts: { masks, images },
            rawResponse: responses,
            id: responses[0]?.id ?? "unknown",
            metadata: {
                provider: AIProvider.OpenAI,
                model: merged.model ?? "gpt-4.1",
                status: "completed",
                requestId: context?.requestId,
                ...(context?.metadata ?? {})
            }
        };
    }

    /**
     * OpenAI Image Editing Capability (streaming version).
     *
     * @param provider - Parent provider instance for lifecycle/config access
     * @param executionContext Execution context
     * @param client - Initialized OpenAI SDK client
     */
    async *editImageStream(
        request: AIRequest<ClientImageEditRequest>,
        executionContext: MultiModalExecutionContext
    ): AsyncGenerator<AIResponseChunk<NormalizedImage[]>> {
        this.provider.ensureInitialized();

        const { input, options, context } = request;
        if (!input?.prompt) {
            throw new Error("Edit prompt is required for image editing");
        }

        // Merge general, provider, model, and request-level options
        const merged = this.provider.getMergedOptions(CapabilityKeys.ImageEditCapabilityKey, options);
        const count = input.params?.count ?? 1;

        try {
            // Prepare content and handle base/mask images
            const { content, masks } = await this.prepareEditContent(input, executionContext);

            // Stream each image request concurrently
            const streams = Array.from({ length: count }, () =>
                this.client.responses.stream({
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
                })
            );

            // Consume each stream and yield images as they complete
            for (let idx = 0; idx < streams.length; idx++) {
                const stream = streams[idx];
                for await (const event of stream) {
                    if (event.type === "response.completed" && event.response?.output) {
                        const outputItems = event.response.output;

                        // Filter completed image_generation_call items
                        const images: NormalizedImage[] = (outputItems ?? [])
                            .filter((i: any) => i.type === "image_generation_call" && i.status === "generating")
                            .map((i: any) => ({
                                base64: i.result,
                                url: ensureDataUri(i.result, "image/png"),
                                mimeType: "image/png",
                                raw: i,
                                index: idx,
                                id: i.id
                            }));

                        // Yield each generated image as a chunk
                        for (const img of images) {
                            yield {
                                output: [img],
                                delta: [img],
                                done: true,
                                id: img.id,
                                multimodalArtifacts: {
                                    masks,
                                    images: [img]
                                },
                                metadata: {
                                    provider: AIProvider.OpenAI,
                                    model: merged.model ?? "gpt-4.1",
                                    status: "completed",
                                    requestId: context?.requestId
                                }
                            };
                        }
                    }
                }
            }
        } catch (err) {
            yield {
                output: [],
                delta: [],
                done: true,
                id: "",
                error: err instanceof Error ? err.message : String(err),
                metadata: {
                    provider: AIProvider.OpenAI,
                    model: merged.model ?? "gpt-4.1",
                    status: "error",
                    requestId: context?.requestId
                }
            };
        }
    }

    /**
     * Prepare content array for OpenAI image edit call.
     * Handles base image selection, last references, auto mask generation, and extra references.
     */
    private async prepareEditContent(
        input: ClientImageEditRequest,
        executionContext: MultiModalExecutionContext
    ): Promise<{
        content: any[];
        masks: ClientReferenceImage[];
    }> {
        const content: any[] = [];

        // Subject / base image
        let baseImage: ClientReferenceImage | undefined = input.referenceImages?.find((i) => i.role === "subject");
        if (!baseImage && executionContext.getLastImage()) {
            const img = executionContext.getLastImage()!;
            baseImage = {
                sourceType: "base64",
                url: img.url,
                base64: img.base64,
                mimeType: img.mimeType,
                id: img.id,
                role: "subject"
            };
        }

        if (!baseImage) {
            throw new Error("Image edit requires a subject image");
        }

        content.push({
            type: "input_image",
            image_url: ensureDataUri(baseImage.url ?? baseImage.base64!, baseImage.mimeType)
        });

        const isSameArtifact = (a?: { id?: string }, b?: { id?: string }) => !!a?.id && !!b?.id && a.id === b.id;

        // Last image reference
        const lastImage = executionContext.getLastImage();
        if (lastImage && !isSameArtifact(lastImage, baseImage)) {
            content.push({
                type: "input_image",
                image_url: ensureDataUri(lastImage.url ?? lastImage.base64!, lastImage.mimeType)
            });
        }

        // Uploaded masks
        const masks = input.referenceImages?.filter((i) => i.role === "mask") ?? [];
        for (const mask of masks) {
            content.push({
                type: "input_image",
                image_url: ensureDataUri(mask.url ?? mask.base64!, mask.mimeType)
            });
        }

        // Extra reference images
        const extraRefs = input.referenceImages?.filter((i) => i.role === "reference" && !isSameArtifact(i, baseImage));
        if (extraRefs?.length) {
            for (const ref of extraRefs) {
                if (ref.url || ref.base64) {
                    content.push({
                        type: "input_image",
                        image_url: ensureDataUri(ref.url ?? ref.base64!, ref.mimeType)
                    });
                }
            }
        }

        // Text prompt
        content.push({ type: "input_text", text: input.prompt });

        return { content, masks };
    }
}
