/**
 * @module providers/openai/capabilities/OpenAIImageAnalysisCapabilityImpl.ts
 * @description OpenAI image-analysis capability adapter built on the Responses API.
 */
import OpenAI from "openai";
import {
    AIProvider,
    AIRequest,
    AIResponse,
    AIResponseChunk,
    BaseProvider,
    CapabilityKeys,
    ClientImageAnalysisRequest,
    ImageAnalysisCapability,
    ImageAnalysisStreamCapability,
    MultiModalExecutionContext,
    NormalizedImageAnalysis,
    resolveReferenceMediaUrl,
    buildMetadata
} from "#root/index.js";

const DEFAULT_OPENAI_IMAGE_ANALYSIS_MODEL = "gpt-4.1";

/**
 * OpenAIImageAnalysisCapabilityImpl: Implements image analysis for OpenAI using the Vision API and tool schema.
 *
 * Uses OpenAI Vision via the Responses API to analyze images and emit structured JSON results using a tool schema.
 *
 * IMPORTANT:
 * - OpenAI provides *semantic* understanding only
 * - No reliable bounding boxes, coordinates, or confidence scores
 * - All outputs are normalized defensively before exposure
 *
 */
export class OpenAIImageAnalysisCapabilityImpl
    implements ImageAnalysisCapability<ClientImageAnalysisRequest>, ImageAnalysisStreamCapability<ClientImageAnalysisRequest>
{
    /**
     * OpenAI-compatible schema for semantic image analysis.
     *
     * NOTE:
     * This schema intentionally avoids spatial guarantees
     * (bounding boxes, confidence scores).
     */
    static OPENAI_IMAGE_ANALYSIS_SCHEMA = {
        type: "object",
        properties: {
            imageIndex: {
                type: "number",
                description: "Index of the analyzed image"
            },
            description: {
                type: "string",
                description: "Natural language description of the image"
            },
            tags: {
                type: "array",
                items: { type: "string" }
            },
            objects: {
                type: "array",
                description: "High-level object mentions without spatial guarantees",
                items: {
                    type: "object",
                    properties: {
                        label: { type: "string" }
                    },
                    required: ["label"]
                }
            },
            text: {
                type: "array",
                items: {
                    type: "object",
                    properties: {
                        text: { type: "string" }
                    },
                    required: ["text"]
                }
            },
            safety: {
                type: "object",
                properties: {
                    flagged: { type: "boolean" },
                    categories: {
                        type: "object",
                        additionalProperties: { type: "boolean" }
                    }
                },
                required: ["flagged"]
            }
        },
        required: []
    };

    /**
     * OpenAI Responses API tool definition.
     *
     * Purpose:
     * - Instructs the model to emit a `function_call` named `image_analysis`
     * - Ensures output matches the schema for safe parsing
     * - Used in both non-streaming and streaming API calls
     */
    static OPENAI_IMAGE_ANALYSIS_TOOL = {
        type: "function",
        name: "image_analysis",
        description: "Analyze an image and return structured analysis results",
        parameters: OpenAIImageAnalysisCapabilityImpl.OPENAI_IMAGE_ANALYSIS_SCHEMA
    };

    private static readonly IMAGE_ANALYSIS_TOOLS = [
        {
            ...OpenAIImageAnalysisCapabilityImpl.OPENAI_IMAGE_ANALYSIS_TOOL,
            parameters: OpenAIImageAnalysisCapabilityImpl.OPENAI_IMAGE_ANALYSIS_SCHEMA
        }
    ] as const;

    private static readonly IMAGE_ANALYSIS_TOOL_CHOICE = {
        type: "function" as const,
        name: "image_analysis"
    };

    /**
     * @param {BaseProvider} provider - Parent provider instance.
     * @param {OpenAI} client - Initialized OpenAI SDK client.
     */
    constructor(
        private readonly provider: BaseProvider,
        private readonly client: OpenAI
    ) {}

    /**
     * Analyze one or more images using OpenAI vision models.
     *
     * @param {AIRequest<ClientImageAnalysisRequest>} request - Unified AI request containing reference images.
     * @param {MultiModalExecutionContext | undefined} executionContext - Optional execution context.
     * @param {AbortSignal | undefined} signal - Optional abort signal.
     * @returns {Promise<AIResponse<NormalizedImageAnalysis[]>>} AIResponse containing normalized image-analysis results.
     */
    async analyzeImage(
        request: AIRequest<ClientImageAnalysisRequest>,
        executionContext?: MultiModalExecutionContext,
        signal?: AbortSignal
    ): Promise<AIResponse<NormalizedImageAnalysis[]>> {
        // Ensure provider has been initialized with credentials + client
        this.provider.ensureInitialized();

        // Abort pre-check
        if (signal?.aborted) {
            throw new Error("Image analysis aborted before request started");
        }

        const { input, options, context } = request;

        const contextImages = executionContext?.getLatestImages() ?? [];
        const images = input.images ?? contextImages ?? [];

        // Defensive guard: must have at least one image
        if (!images.length) {
            throw new Error("At least one image is required for analysis");
        }

        // Defensive guard: schema must exist and be valid
        // Throws if schema is missing or not an object (prevents runtime errors)
        if (
            !OpenAIImageAnalysisCapabilityImpl.OPENAI_IMAGE_ANALYSIS_SCHEMA ||
            OpenAIImageAnalysisCapabilityImpl.OPENAI_IMAGE_ANALYSIS_SCHEMA.type !== "object"
        ) {
            throw new Error("Invalid OpenAI function schema: root must be type 'object'");
        }

        // Merge general, provider, model, and request-level options
        // Ensures all relevant config is passed to the API
        const merged = this.provider.getMergedOptions(CapabilityKeys.ImageAnalysisCapabilityKey, options);

        const content = this.buildContent(images, input.prompt);

        const response = await this.client.responses.create(
            {
                model: merged.model ?? DEFAULT_OPENAI_IMAGE_ANALYSIS_MODEL,
                input: [{ role: "user", content }],
                tools: OpenAIImageAnalysisCapabilityImpl.IMAGE_ANALYSIS_TOOLS as any,
                tool_choice: OpenAIImageAnalysisCapabilityImpl.IMAGE_ANALYSIS_TOOL_CHOICE,
                ...(merged.modelParams ?? {}),
                ...(merged.providerParams ?? {})
            },
            { signal }
        );

        // Parse the output from OpenAI
        // Only process items that are function calls for our tool
        const analyses: NormalizedImageAnalysis[] = [];
        for (const item of response.output ?? []) {
            // Only process function_call outputs for the image_analysis tool
            if (item.type !== "function_call" || item.name !== "image_analysis") {
                continue;
            }

            try {
                const parsed = JSON.parse(item.arguments);
                const normalized = this.normalizeAnalyses(parsed);
                analyses.push(...normalized);
            } catch (err) {
                console.warn("Failed to parse image analysis output:", err);
            }
        }

        // Return provider-agnostic normalized response.
        return {
            output: analyses,
            rawResponse: response,
            id: response.id ?? context?.requestId ?? crypto.randomUUID(),
            metadata: buildMetadata(context?.metadata, {
                provider: AIProvider.OpenAI,
                model: merged.model,
                status: response?.status ?? "completed",
                requestId: context?.requestId
            })
        };
    }

    /**
     * Analyze images with streaming output.
     *
     * Emits one or more AIResponseChunk objects as soon as the
     * image_analysis function call completes.
     *
     * @param request - Unified AI request containing reference images
     * @param executionContext Optional execution context
     * @param signal Optional abort signal
     * @returns AIResponseChunk containing normalized image analysis results
     */
    async *analyzeImageStream(
        request: AIRequest<ClientImageAnalysisRequest>,
        executionContext?: MultiModalExecutionContext,
        signal?: AbortSignal
    ): AsyncGenerator<AIResponseChunk<NormalizedImageAnalysis[]>> {
        // Ensure provider has been initialized with credentials + client
        this.provider.ensureInitialized();

        const { input, options, context } = request;

        const contextImages = executionContext?.getLatestImages() ?? [];
        const images = input.images ?? contextImages ?? [];

        // Defensive guard: must have at least one image
        if (!images.length) {
            throw new Error("At least one image is required for analysis");
        }

        // Defensive guard: schema must exist and be valid
        if (
            !OpenAIImageAnalysisCapabilityImpl.OPENAI_IMAGE_ANALYSIS_SCHEMA ||
            OpenAIImageAnalysisCapabilityImpl.OPENAI_IMAGE_ANALYSIS_SCHEMA.type !== "object"
        ) {
            throw new Error("Invalid OpenAI function schema: root must be type 'object'");
        }

        // Merge general, provider, model, and request-level options
        const merged = this.provider.getMergedOptions(CapabilityKeys.ImageAnalysisStreamCapabilityKey, options);

        const content = this.buildContent(images, input.prompt);

        let responseId: string | undefined;
        try {
            const stream = this.client.responses.stream(
                {
                    model: merged.model ?? DEFAULT_OPENAI_IMAGE_ANALYSIS_MODEL,
                    input: [{ role: "user", content }],
                    tools: OpenAIImageAnalysisCapabilityImpl.IMAGE_ANALYSIS_TOOLS as any,
                    tool_choice: OpenAIImageAnalysisCapabilityImpl.IMAGE_ANALYSIS_TOOL_CHOICE,
                    ...(merged.modelParams ?? {}),
                    ...(merged.providerParams ?? {})
                },
                { signal }
            );

            // Iterate over streamed events from OpenAI
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

                // Only process completed output items
                if (event.type !== "response.output_item.done") {
                    continue;
                }
                const item = event.item;

                // Only process function_call outputs for the image_analysis tool
                if (item.type !== "function_call" || item.name !== "image_analysis") {
                    continue;
                }

                // Arguments are guaranteed to be JSON strings when produced by a function call
                const parsed = JSON.parse(item.arguments);

                // If the payload is an array, spread into analyses; otherwise, push single result
                const analyses = this.normalizeAnalyses(parsed);

                // Yield a completed chunk with the analyses
                yield {
                    output: analyses,
                    delta: analyses,
                    done: true,
                    id: responseId ?? context?.requestId ?? crypto.randomUUID(),
                    metadata: buildMetadata(context?.metadata, {
                        provider: AIProvider.OpenAI,
                        model: merged.model,
                        status: "completed",
                        requestId: context?.requestId
                    })
                };
            }
        } catch (err) {
            // Abort is NOT an error — do not emit a terminal chunk
            if (signal?.aborted) {
                return;
            }

            // Yield error chunk if the stream throws
            yield {
                output: [],
                delta: [],
                done: true,
                id: responseId,
                metadata: buildMetadata(context?.metadata, {
                    provider: AIProvider.OpenAI,
                    model: merged.model,
                    status: "error",
                    requestId: context?.requestId,
                    error: err instanceof Error ? err.message : String(err)
                })
            };
        }
    }

    private normalizeAnalyses(payload: NormalizedImageAnalysis | NormalizedImageAnalysis[]): NormalizedImageAnalysis[] {
        const items = Array.isArray(payload) ? payload : payload ? [payload] : [];
        const normalized: NormalizedImageAnalysis[] = [];
        for (const item of items) {
            const tags =
                Array.isArray(item.tags) && item.tags.length > 0
                    ? item.tags.filter((tag): tag is string => Boolean(tag))
                    : undefined;
            const objects =
                Array.isArray(item.objects) && item.objects.length > 0
                    ? item.objects.map((o) => ({ label: o.label }))
                    : undefined;
            const text =
                Array.isArray(item.text) && item.text.length > 0 ? item.text.map((t) => ({ text: t.text })) : undefined;

            normalized.push({
                id: item.id ?? crypto.randomUUID(),
                description: item.description,
                tags,
                objects,
                text,
                safety: item.safety ? { flagged: Boolean(item.safety.flagged) } : undefined
            });
        }
        return normalized;
    }

    private buildContent(images: { base64?: string; mimeType?: string }[], prompt?: string): any[] {
        const content = new Array(images.length + 1);
        for (let i = 0; i < images.length; i++) {
            const img = images[i];
            content[i] = { type: "input_image", image_url: resolveReferenceMediaUrl(img, "image/png") };
        }
        content[images.length] = {
            type: "input_text",
            text: prompt ?? "Analyze the provided image(s) and return structured results."
        };
        return content;
    }
}
