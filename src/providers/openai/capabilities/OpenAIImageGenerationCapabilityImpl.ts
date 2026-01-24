import OpenAI from "openai";
import {
    AIProvider,
    AIRequest,
    AIResponse,
    AIResponseChunk,
    BaseProvider,
    CapabilityKeys,
    ClientImageGenerationRequest,
    ImageGenerationCapability,
    ImageGenerationStreamCapability,
    MultiModalExecutionContext,
    NormalizedImage
} from "#root/index.js";

/**
 * Implements image generation for OpenAI, supporting both non-streaming and streaming modes.
 *
 * Responsibilities:
 * - Converts prompts and optional reference images into OpenAI requests
 * - Normalizes outputs into `NormalizedImage[]`
 * - Handles multiple images, model parameters, and streaming events
 *
 * Usage:
 *   Instantiate with a parent provider and OpenAI client, then call `generateImage` or `generateImageStream`.
 */
export class OpenAIImageGenerationCapabilityImpl
    implements
        ImageGenerationCapability<ClientImageGenerationRequest>,
        ImageGenerationStreamCapability<ClientImageGenerationRequest>
{
    /**
     * Constructor for OpenAI image generation capability implementation.
     * @param provider Parent provider instance for lifecycle/config access
     * @param client Initialized OpenAI SDK client
     */
    constructor(
        private readonly provider: BaseProvider,
        private readonly client: OpenAI
    ) {}

    /**
     * Generates images using OpenAI Responses API (non-streaming).
     *
     * Steps:
     * - Validates prompt
     * - Merges provider/model/request options
     * - Builds prompt and reference image content
     * - Sends concurrent requests if count > 1
     * - Normalizes and returns image output
     *
     * @param request Unified AIRequest containing prompt, reference images, and params
     * @param _executionContext Optional execution context (unused)
     * @returns AIResponse containing normalized images
     * @throws Error if prompt is missing or generation fails
     */
    async generateImage(
        request: AIRequest<ClientImageGenerationRequest>,
        _executionContext?: MultiModalExecutionContext
    ): Promise<AIResponse<NormalizedImage[]>> {
        // Ensure provider has been initialized with credentials + client
        this.provider.ensureInitialized();

        const { input, options, context } = request;

        // Defensive guard: prompt is required
        if (!input?.prompt) {
            throw new Error("Prompt is required for image generation");
        }

        // Merge general, provider, model, and request-level options
        const merged = this.provider.getMergedOptions(CapabilityKeys.ImageGenerationCapabilityKey, options);

        const count = input.params?.count ?? 1;

        // Build content array: prompt + optional reference images
        let prompt = input.prompt;
        const content: any[] = [];
        if (input.referenceImages?.length) {
            // If reference images are provided, enhance prompt and add images to content
            prompt = `
                Use the provided reference image(s) as visual inspiration. 
                Incorporate their lighting, color palette, mood, and overall style where appropriate, but still follow the description below.
                Description: ${input.prompt}`.trim();
            for (const ref of input.referenceImages) {
                content.push({ type: "input_image", image_url: ref.url });
            }
        }

        // Always include the textual prompt
        content.push({ type: "input_text", text: prompt });

        // Generate images concurrently if count > 1
        const responses = await Promise.all(
            Array.from({ length: count }, () =>
                this.client.responses.create({
                    model: merged.model ?? "gpt-4.1",
                    input: [{ role: "user", content }],
                    tools: [
                        {
                            type: "image_generation",
                            size: input.params?.size,
                            background: input.params?.background,
                            quality: input.params?.quality,
                            style: input.params?.style
                        }
                    ],
                    ...(merged.modelParams ?? {}),
                    ...(merged.providerParams ?? {})
                })
            )
        );

        // Flatten nested response items and normalize output
        const images = responses.flatMap((response, idx) =>
            (response.output ?? []).flatMap((item) => {
                if (item.type === "image_generation_call" && "result" in item && typeof item.result === "string") {
                    return [
                        {
                            base64: item.result,
                            url: undefined,
                            mimeType: "image/png",
                            raw: item,
                            index: idx,
                            id: item.id
                        }
                    ];
                }
                return [];
            })
        );

        return {
            output: images,
            rawResponse: responses,
            id: responses[0]?.id ?? "unknown",
            metadata: {
                provider: AIProvider.OpenAI,
                model: merged.model,
                status: responses.every((r) => r.status === "completed") ? "completed" : "partial",
                requestId: context?.requestId,
                ...(context?.metadata ?? {})
            }
        };
    }

    /**
     * Streaming image generation using OpenAI Responses API.
     * Emits partial image chunks as they become available.
     *
     * Steps:
     * - Validates prompt
     * - Merges provider/model/request options
     * - Builds prompt and reference image content
     * - Starts streaming generation for each image
     * - Yields image chunks as they are received
     * - Handles errors by yielding an error chunk
     *
     * @param request Unified AIRequest containing prompt, reference images, and params
     * @param _executionContext Optional execution context (unused)
     * @returns AsyncGenerator yielding AIResponseChunk<NormalizedImage[]>
     * @throws Error if prompt is missing
     */
    async *generateImageStream(
        request: AIRequest<ClientImageGenerationRequest>,
        _executionContext?: MultiModalExecutionContext
    ): AsyncGenerator<AIResponseChunk<NormalizedImage[]>> {
        // Ensure provider has been initialized with credentials + client
        this.provider.ensureInitialized();

        const { input, options, context } = request;
        if (!input?.prompt) {
            throw new Error("Prompt is required for image generation");
        }

        // Merge general, provider, model, and request-level options
        const merged = this.provider.getMergedOptions(CapabilityKeys.ImageGenerationStreamCapabilityKey, options);
        const count = input.params?.count ?? 1;

        try {
            // Build prompt content including optional reference images
            let prompt = input.prompt;
            const content: any[] = [];
            if (input.referenceImages?.length) {
                prompt = `
Use the provided reference image(s) as visual inspiration.
Incorporate their lighting, color palette, mood, and overall style where appropriate,
but still follow the description below.
Description: ${input.prompt}`.trim();
                for (const ref of input.referenceImages) {
                    content.push({ type: "input_image", image_url: ref.url });
                }
            }
            content.push({ type: "input_text", text: prompt });

            // Start streaming generation for each image
            const streams = Array.from({ length: count }, () =>
                this.client.responses.stream({
                    model: merged.model ?? "gpt-4.1",
                    input: [{ role: "user", content }],
                    tools: [
                        {
                            type: "image_generation",
                            size: input.params?.size,
                            background: input.params?.background,
                            quality: input.params?.quality,
                            style: input.params?.style
                        }
                    ],
                    ...(merged.modelParams ?? {}),
                    ...(merged.providerParams ?? {})
                })
            );

            // Consume streams and yield image chunks as they are received
            for (let idx = 0; idx < streams.length; idx++) {
                const stream = streams[idx];
                for await (const event of stream) {
                    if (event.type !== "response.completed") {
                        continue;
                    }
                    const outputItems = event.response?.output ?? [];
                    const images: NormalizedImage[] = [];
                    for (const item of outputItems) {
                        if (
                            typeof item === "object" &&
                            item !== null &&
                            (item as any).type === "image_generation_call" &&
                            typeof (item as any).result === "string"
                        ) {
                            images.push({
                                base64: (item as any).result,
                                url: undefined,
                                mimeType: "image/png",
                                raw: item,
                                index: idx,
                                id: (item as any).id
                            });
                        }
                    }
                    // Yield each image chunk
                    for (const img of images) {
                        yield {
                            output: [img],
                            delta: [img],
                            done: true,
                            id: img.id,
                            metadata: {
                                provider: AIProvider.OpenAI,
                                model: merged.model,
                                requestId: context?.requestId,
                                status: "completed"
                            }
                        };
                    }
                }
            }
        } catch (err) {
            // Yield error chunk if streaming fails
            yield {
                output: [],
                delta: [],
                done: true,
                id: "",
                error: err instanceof Error ? err.message : String(err),
                metadata: {
                    provider: AIProvider.OpenAI,
                    model: merged.model,
                    status: "error",
                    requestId: context?.requestId
                }
            };
        }
    }
}
