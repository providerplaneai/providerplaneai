/**
 * @module providers/openai/capabilities/OpenAIImageGenerationCapabilityImpl.ts
 * @description Provider implementations and capability adapters.
 */
import OpenAI from "openai";
import {
    AIProvider,
    AIRequest,
    AIResponse,
    AIResponseChunk,
    BaseProvider,
    CapabilityKeys,
    ClientImageGenerationRequest,
    ensureDataUri,
    ImageGenerationCapability,
    ImageGenerationStreamCapability,
    MultiModalExecutionContext,
    NormalizedImage
} from "#root/index.js";

const DEFAULT_OPENAI_IMAGE_MODEL = "gpt-4.1";

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
/**
 * @public
 * @description Provider capability implementation for OpenAIImageGenerationCapabilityImpl.
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
     * @param signal AbortSignal for request cancellation
     * @returns AIResponse containing normalized images
     * @throws Error if prompt is missing or generation fails
     */
    async generateImage(
        request: AIRequest<ClientImageGenerationRequest>,
        _executionContext?: MultiModalExecutionContext,
        signal?: AbortSignal
    ): Promise<AIResponse<NormalizedImage[]>> {
        // Ensure provider has been initialized with credentials + client
        this.provider.ensureInitialized();

        if (signal?.aborted) {
            throw new Error("Image generation aborted before request started");
        }

        const { input, options, context } = request;
        // Defensive guard: prompt is required
        if (!input?.prompt) {
            throw new Error("Prompt is required for image generation");
        }

        // Merge general, provider, model, and request-level options
        const merged = this.provider.getMergedOptions(CapabilityKeys.ImageGenerationCapabilityKey, options);

        // Generate images via OpenAI Responses API
        const response = await this.client.responses.create(
            {
                model: merged.model ?? DEFAULT_OPENAI_IMAGE_MODEL,
                input: [{ role: "user", content: this.buildContent(input) }],
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
            },
            { signal }
        );

        const images = this.parseImages(response.output ?? []);
        if (images.length === 0) {
            throw new Error("OpenAI image generation returned no image artifacts");
        }

        return {
            output: images,
            rawResponse: response,
            id: response.id ?? context?.requestId ?? crypto.randomUUID(),
            metadata: {
                ...(context?.metadata ?? {}),
                provider: AIProvider.OpenAI,
                model: merged.model,
                status: response.status ?? "completed",
                requestId: context?.requestId
            }
        };
    }

    /**
     * Streaming image generation using OpenAI Responses API.
     * Emits partial image chunks as they become available.
     *
     * Note:
     * OpenAI image generation streams lifecycle events only.
     * Image payloads are delivered atomically once generation completes.
     * Consumers should expect exactly one image-bearing chunk.
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
     * @param signal AbortSignal for request cancellation
     * @returns AsyncGenerator yielding AIResponseChunk<NormalizedImage[]>
     * @throws Error if prompt is missing
     */
    async *generateImageStream(
        request: AIRequest<ClientImageGenerationRequest>,
        _executionContext?: MultiModalExecutionContext,
        signal?: AbortSignal
    ): AsyncGenerator<AIResponseChunk<NormalizedImage[]>> {
        // Ensure provider has been initialized with credentials + client
        this.provider.ensureInitialized();

        const { input, options, context } = request;
        if (!input?.prompt) {
            throw new Error("Prompt is required for image generation");
        }

        // Merge general, provider, model, and request-level options
        const merged = this.provider.getMergedOptions(CapabilityKeys.ImageGenerationStreamCapabilityKey, options);

        let responseId: string | undefined;
        let imageIndex = 0;
        try {
            const stream = this.client.responses.stream(
                {
                    model: merged.model ?? DEFAULT_OPENAI_IMAGE_MODEL,
                    input: [{ role: "user", content: this.buildContent(input) }],
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
                },
                { signal }
            );

            // Consume stream and yield image ONCE when ready
            for await (const event of stream) {
                if (signal?.aborted) {
                    return;
                }

                if (
                    !responseId &&
                    (event.type === "response.created" || event.type === "response.completed") &&
                    "response" in event &&
                    event.response?.id
                ) {
                    responseId = event.response.id;
                }

                if (event.type !== "response.completed") {
                    continue;
                }

                const images = this.parseImages(event.response.output ?? []);

                for (const image of images) {
                    image.index = imageIndex++;
                    image.id ??= `image-${image.index}`;

                    // Emit each image as its own chunk
                    yield {
                        delta: [image],
                        output: [image],
                        done: false,
                        id: responseId ?? context?.requestId ?? crypto.randomUUID(),
                        metadata: {
                            ...(context?.metadata ?? {}),
                            provider: AIProvider.OpenAI,
                            model: merged.model,
                            status: "incomplete",
                            requestId: context?.requestId
                        }
                    };
                }
            }

            // Final completion marker
            yield {
                delta: [],
                output: [],
                done: true,
                id: responseId ?? context?.requestId ?? crypto.randomUUID(),
                metadata: {
                    ...(context?.metadata ?? {}),
                    provider: AIProvider.OpenAI,
                    model: merged.model,
                    status: "completed",
                    requestId: context?.requestId
                }
            };
        } catch (err) {
            // Abort is NOT an error — exit silently
            if (signal?.aborted) {
                return;
            }

            // Yield error chunk if streaming fails
            yield {
                output: [],
                delta: [],
                done: true,
                id: responseId ?? context?.requestId ?? crypto.randomUUID(),
                metadata: {
                    ...(context?.metadata ?? {}),
                    provider: AIProvider.OpenAI,
                    model: merged.model,
                    status: "error",
                    requestId: context?.requestId,
                    error: err instanceof Error ? err.message : String(err)
                }
            };
        }
    }

    private buildContent(input: ClientImageGenerationRequest): any[] {
        let prompt = input.prompt!;
        const content: any[] = [];

        if (input.referenceImages?.length) {
            prompt = `
Use the provided reference image(s) as visual inspiration.
Incorporate their lighting, color palette, mood, and overall style where appropriate,
but still follow the description below.
Description: ${input.prompt}
            `.trim();

            for (const ref of input.referenceImages) {
                content.push({ type: "input_image", image_url: ref.url });
            }
        }

        content.push({ type: "input_text", text: prompt });
        return content;
    }

    private parseImages(outputItems: any[]): NormalizedImage[] {
        return outputItems
            .filter((item) => item.type === "image_generation_call")
            .map((item) => {
                const base64 = item.result ?? item.image_base64 ?? item.b64_json;

                if (!base64) {
                    return null;
                }

                return {
                    id: item.id,
                    base64,
                    url: ensureDataUri(base64, "image/png"),
                    mimeType: "image/png",
                    raw: item
                } as NormalizedImage;
            })
            .filter(Boolean) as NormalizedImage[];
    }
}
