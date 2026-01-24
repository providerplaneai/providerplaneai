import OpenAI from "openai";
import {
    AIProvider,
    AIRequest,
    AIResponse,
    AIResponseChunk,
    BaseProvider,
    CapabilityKeys,
    ClientImageAnalysisRequest,
    ensureDataUri,
    ImageAnalysisCapability,
    ImageAnalysisStreamCapability,
    MultiModalExecutionContext,
    NormalizedImageAnalysis
} from "#root/index.js";

/**
 * OpenAIImageAnalysisCapabilityImpl: Implements image analysis for OpenAI using the Vision API and tool schema.
 *
 * Uses OpenAI Vision via the Responses API to analyze images and emit structured JSON results using a tool schema.
 *
 * @template TRequest Image analysis request type
 * @returns AIResponse containing normalized images
 * @throws Error if prompt is missing or analysis fails
 */
export class OpenAIImageAnalysisCapabilityImpl
    implements ImageAnalysisCapability<ClientImageAnalysisRequest>, ImageAnalysisStreamCapability<ClientImageAnalysisRequest>
{
    /**
     * JSON schema describing the structured output expected from the
     * `image_analysis` tool call.
     *
     * Used for:
     * - Telling OpenAI to emit structured, validated output
     * - Ensuring model output is reliably parseable as JSON
     * - Avoiding brittle text parsing and hallucinated formats
     *
     * This schema should match the expected NormalizedImageAnalysis structure.
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
                items: {
                    type: "object",
                    properties: {
                        label: { type: "string" },
                        confidence: { type: "number" },
                        boundingBox: {
                            type: "object",
                            properties: {
                                x: { type: "number" },
                                y: { type: "number" },
                                width: { type: "number" },
                                height: { type: "number" }
                            },
                            required: ["x", "y", "width", "height"]
                        }
                    },
                    required: ["label"]
                }
            },
            text: {
                type: "array",
                items: {
                    type: "object",
                    properties: {
                        text: { type: "string" },
                        confidence: { type: "number" }
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

    /**
     * @param provider Parent provider instance
     * @param client Initialized OpenAI SDK client
     */
    constructor(
        private readonly provider: BaseProvider,
        private readonly client: OpenAI
    ) {}

    /**
     * Analyze one or more images using OpenAI vision models.
     *
     * @param request - Unified AI request containing reference images
     * @param _executionContext Optional execution context
     * @returns AIResponse containing normalized image analysis results
     */
    async analyzeImage(
        request: AIRequest<ClientImageAnalysisRequest>,
        _executionContext?: MultiModalExecutionContext
    ): Promise<AIResponse<NormalizedImageAnalysis[]>> {
        // Ensure provider has been initialized with credentials + client
        this.provider.ensureInitialized();

        const { input, options, context } = request;
        const images = input.images ?? [];

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

        // Build input payload for OpenAI API
        // Each image is encoded as a data URI and added to the content array
        const content: any[] = [];
        for (const img of images) {
            content.push({ type: "input_image", image_url: ensureDataUri(img.base64!, img.mimeType) });
        }

        // Add instruction text to guide the model's output
        content.push({ type: "input_text", text: "Analyze the provided image(s) and return structured results." });

        const response = await this.client.responses.create({
            model: merged.model ?? "gpt-4.1",
            input: [{ role: "user", content }],
            tools: [
                {
                    ...OpenAIImageAnalysisCapabilityImpl.OPENAI_IMAGE_ANALYSIS_TOOL,
                    parameters: OpenAIImageAnalysisCapabilityImpl.OPENAI_IMAGE_ANALYSIS_SCHEMA
                }
            ],
            ...(merged.modelParams ?? {}),
            ...(merged.providerParams ?? {})
        });

        // Parse the output from OpenAI
        // Only process items that are function calls for our tool
        const analyses: NormalizedImageAnalysis[] = [];
        for (const item of response.output ?? []) {
            // Only process function_call outputs for the image_analysis tool
            if (item.type !== "function_call") {
                continue;
            }
            if (item.name !== "image_analysis") {
                continue;
            }

            try {
                // Arguments are guaranteed to be JSON strings when produced by a function call
                const payload = JSON.parse(item.arguments) as NormalizedImageAnalysis | NormalizedImageAnalysis[];
                // If the payload is an array, spread into analyses; otherwise, push single result
                if (Array.isArray(payload)) {
                    analyses.push(...payload);
                } else if (payload) {
                    analyses.push(payload);
                }
            } catch (err) {
                // Log parse errors for debugging
                console.warn("Failed to parse image analysis arguments:", item.arguments, err);
            }
        }

        // Return provider-agnostic normalized response.
        return {
            output: analyses,
            rawResponse: response,
            id: response?.id ?? "unknown",
            metadata: {
                provider: AIProvider.OpenAI,
                model: merged.model,
                status: response?.status ?? "completed",
                requestId: context?.requestId,
                ...(context?.metadata ?? {})
            }
        };
    }

    /**
     * Analyze images with streaming output.
     *
     * Emits one or more AIResponseChunk objects as soon as the
     * image_analysis function call completes.
     *
     * @param request - Unified AI request containing reference images
     * @param _executionContext Optional execution context
     * @returns AIResponseChunk containing normalized image analysis results
     */
    async *analyzeImageStream(
        request: AIRequest<ClientImageAnalysisRequest>,
        _executionContext?: MultiModalExecutionContext
    ): AsyncGenerator<AIResponseChunk<NormalizedImageAnalysis[]>> {
        // Ensure provider has been initialized with credentials + client
        this.provider.ensureInitialized();

        const { input, options, context } = request;
        const images = input.images ?? [];

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

        // Build content payload for OpenAI API
        // Each image is encoded as a data URI and added to the content array
        const content: any[] = [];
        for (const img of images) {
            content.push({
                type: "input_image",
                image_url: ensureDataUri(img.base64!, img.mimeType)
            });
        }

        // Add instruction text to guide the model's output
        content.push({
            type: "input_text",
            text: "Analyze the provided image(s) and return structured results."
        });

        let stream;
        let yielded = false;
        try {
            stream = await this.client.responses.stream({
                model: merged.model ?? "gpt-4.1",
                input: [{ role: "user", content }],
                tools: [
                    {
                        ...OpenAIImageAnalysisCapabilityImpl.OPENAI_IMAGE_ANALYSIS_TOOL,
                        parameters: OpenAIImageAnalysisCapabilityImpl.OPENAI_IMAGE_ANALYSIS_SCHEMA
                    }
                ],
                ...(merged.modelParams ?? {}),
                ...(merged.providerParams ?? {})
            });

            // Iterate over streamed events from OpenAI
            for await (const event of stream) {
                // Only process completed output items
                if (event.type !== "response.output_item.done") {
                    continue;
                }
                const item = event.item;
                // Only process function_call outputs for the image_analysis tool
                if (item.type !== "function_call" || item.name !== "image_analysis") {
                    continue;
                }
                let payload: NormalizedImageAnalysis | NormalizedImageAnalysis[] | null = null;
                try {
                    // Arguments are guaranteed to be JSON strings when produced by a function call
                    payload = JSON.parse(item.arguments);
                } catch (err) {
                    // Yield error chunk if parsing fails
                    yield {
                        output: [],
                        delta: [],
                        done: true,
                        error: `Failed to parse image analysis output: ${err instanceof Error ? err.message : String(err)}`,
                        metadata: {
                            provider: AIProvider.OpenAI,
                            model: merged.model,
                            status: "error",
                            requestId: context?.requestId
                        }
                    };
                    yielded = true;
                    continue;
                }
                // If the payload is an array, spread into analyses; otherwise, push single result
                const analyses = Array.isArray(payload) ? payload : payload ? [payload] : [];
                // Yield a completed chunk with the analyses
                yield {
                    output: analyses,
                    delta: analyses,
                    done: true,
                    id: item.call_id,
                    metadata: {
                        provider: AIProvider.OpenAI,
                        model: merged.model,
                        status: "completed",
                        requestId: context?.requestId
                    }
                };
                yielded = true;
            }
            // If no valid output was yielded, yield a final empty chunk
            if (!yielded) {
                yield {
                    output: [],
                    delta: [],
                    done: true,
                    metadata: {
                        provider: AIProvider.OpenAI,
                        model: merged.model,
                        status: "completed",
                        requestId: context?.requestId
                    }
                };
            }
        } catch (err) {
            // Yield error chunk if the stream throws
            yield {
                output: [],
                delta: [],
                done: true,
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
