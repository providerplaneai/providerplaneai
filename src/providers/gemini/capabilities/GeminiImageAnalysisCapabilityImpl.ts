import { GoogleGenAI } from "@google/genai";
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
    parseBestEffortJson
} from "#root/index.js";

const DEFAULT_GEMINI_IMAGE_ANALYSIS_MODEL = "gemini-2.5-pro";

/**
 * GeminiImageAnalysisCapabilityImpl: Implements image analysis for Gemini using strict prompting.
 *
 * Relies on strict prompting instead of schemas/tools. Gemini is instructed to emit raw JSON only.
 */
const prompt = `
You are an image analysis system.

Return ONLY valid JSON matching this interface:

{
  imageIndex?: number;
  description?: string;
  tags?: string[];
  text?: { text: string; confidence?: number }[];
  safety?: {
    flagged: boolean;
    categories?: Record<string, boolean>;
  };
}

Rules:
- Output JSON only
- No markdown
- No explanations
- Omit fields you are unsure about
`;

/**
 * Internal Gemini parse shape.
 * Matches the strict JSON prompt.
 */
type GeminiImageAnalysisPayload = {
    imageIndex?: number;
    description?: string;
    tags?: string[];
    text?: { text: string; confidence?: number }[];
    safety?: {
        flagged: boolean;
        categories?: Record<string, boolean>;
    };
};

/**
 * Gemini image analysis capability.
 *
 * Uses Gemini multimodal generation to analyze images and
 * returns best-effort structured results by prompting the
 * model to emit strict JSON.
 *
 * NOTE:
 * - Gemini does NOT support tool/function calling
 * - Gemini does not support native JSON schema tools like OpenAI.
 * - JSON structure is enforced via prompting only
 * - Bounding boxes and confidence scores are optional / best-effort
 */
export class GeminiImageAnalysisCapabilityImpl
    implements ImageAnalysisCapability<ClientImageAnalysisRequest>, ImageAnalysisStreamCapability<ClientImageAnalysisRequest>
{
    /**
     * @param provider Parent provider instance
     * @param client Initialized GoogleGenAI client
     */
    constructor(
        private readonly provider: BaseProvider,
        private readonly client: GoogleGenAI
    ) {}

    /**
     * Analyze one or more images using Gemini multimodal models.
     *
     * @param request Unified AI request containing images to analyze
     * @param executionContext Optional execution context
     * @param signal Optional abort signal
     * @returns Provider-agnostic normalized image analysis results
     */
    async analyzeImage(
        request: AIRequest<ClientImageAnalysisRequest>,
        executionContext?: MultiModalExecutionContext,
        signal?: AbortSignal
    ): Promise<AIResponse<NormalizedImageAnalysis[]>> {
        // Ensure the provider has credentials and is initialized
        this.provider.ensureInitialized();

        const { input, options, context } = request;

        const contextImages = executionContext?.getLatestImages() ?? [];
        const images = input.images ?? contextImages ?? [];

        // Defensive guard
        if (!images.length) {
            throw new Error("At least one image is required for analysis");
        }

        if (signal?.aborted) {
            throw new Error("Request aborted");
        }

        // Merge general, provider, model, and request-level options
        const merged = this.provider.getMergedOptions(CapabilityKeys.ImageAnalysisCapabilityKey, options);

        // Prompt + inline image bytes in a single user turn keeps ordering deterministic.
        const contents = [
            {
                role: "user",
                parts: [
                    { text: prompt },
                    ...images.map((img) => ({
                        inlineData: {
                            mimeType: img.mimeType ?? "image/png",
                            data: img.base64!
                        }
                    }))
                ]
            }
        ];

        const response = await this.client.models.generateContent({
            model: merged.model ?? DEFAULT_GEMINI_IMAGE_ANALYSIS_MODEL,
            contents,
            config: {
                temperature: 0,
                ...(merged.modelParams ?? {})
            },
            ...(merged.providerParams ?? {})
        });

        // Gemini can return imperfect JSON; parseBestEffortJson tolerates minor formatting drift.
        const parsed = parseBestEffortJson<GeminiImageAnalysisPayload>(response.text ?? "");

        const normalized = this.normalizeGeminiAnalyses(parsed, images);

        // Return provider-agnostic normalized response.
        return {
            output: normalized,
            rawResponse: response,
            id: response.responseId ?? context?.requestId ?? crypto.randomUUID(),
            metadata: {
                ...(context?.metadata ?? {}),
                provider: AIProvider.Gemini,
                model: merged.model,
                status: "completed",
                requestId: context?.requestId,
                // Useful telemetry signal when model emits fewer/more objects than input images.
                countsMatch: parsed.length === images.length
            }
        };
    }

    /**
     * Analyze images with streaming output using Gemini.
     *
     * IMPORTANT:
     * - Gemini does NOT stream structured objects
     * - It streams raw text tokens
     * - When multiple images are analyzed, Gemini emits
     *   MULTIPLE JSON OBJECTS back-to-back, separated by newlines
     *
     * Example streamed text:
     *   { ...image 0 json... }
     *   { ...image 1 json... }
     *
     * This implementation:
     * - Accumulates text chunks
     * - Emits ONE final chunk (OpenAI-compatible semantics)
     */
    async *analyzeImageStream(
        request: AIRequest<ClientImageAnalysisRequest>,
        executionContext?: MultiModalExecutionContext,
        signal?: AbortSignal
    ): AsyncGenerator<AIResponseChunk<NormalizedImageAnalysis[]>> {
        this.provider.ensureInitialized();

        const { input, options, context } = request;

        const contextImages = executionContext?.getLatestImages() ?? [];
        const images = input.images ?? contextImages ?? [];

        if (!images.length) {
            throw new Error("At least one image is required for analysis");
        }

        const merged = this.provider.getMergedOptions(CapabilityKeys.ImageAnalysisStreamCapabilityKey, options);

        let responseId: string | undefined;
        let accumulatedText = "";

        try {
            const stream = await this.client.models.generateContentStream({
                model: merged.model ?? DEFAULT_GEMINI_IMAGE_ANALYSIS_MODEL,
                contents: [
                    {
                        role: "user",
                        parts: [
                            { text: prompt },
                            ...images.map((img) => ({
                                inlineData: {
                                    mimeType: img.mimeType ?? "image/png",
                                    data: img.base64!
                                }
                            }))
                        ]
                    }
                ],
                config: {
                    temperature: 0,
                    ...(merged.modelParams ?? {})
                },
                ...(merged.providerParams ?? {})
            });

            // Gemini streaming is treated as transport only.
            for await (const chunk of stream) {
                if (signal?.aborted) {
                    throw new Error("Request aborted");
                }
                responseId ??= chunk.responseId;
                if (chunk.text) {
                    accumulatedText += chunk.text;
                }
            }

            const parsed = parseBestEffortJson<GeminiImageAnalysisPayload>(accumulatedText);

            const normalized = this.normalizeGeminiAnalyses(parsed, images);

            yield {
                output: normalized,
                delta: normalized,
                done: true,
                id: responseId ?? crypto.randomUUID(),
                metadata: {
                    ...(context?.metadata ?? {}),
                    provider: AIProvider.Gemini,
                    model: merged.model,
                    status: "completed",
                    requestId: context?.requestId,
                    // Lets callers detect partial/misaligned structured output quickly.
                    countsMatch: parsed.length === images.length
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
                id: responseId ?? crypto.randomUUID(),
                metadata: {
                    ...(context?.metadata ?? {}),
                    provider: AIProvider.Gemini,
                    model: merged.model,
                    status: "error",
                    requestId: context?.requestId,
                    error: err instanceof Error ? err.message : String(err)
                }
            };
        }
    }

    private normalizeGeminiAnalyses(
        payload: GeminiImageAnalysisPayload | GeminiImageAnalysisPayload[],
        images: { id?: string }[]
    ): NormalizedImageAnalysis[] {
        // Single-object and array outputs are both accepted to keep parsing resilient.
        const items = Array.isArray(payload) ? payload : [payload];

        return items.map((item, index) => ({
            // Prefer explicit imageIndex from model output; otherwise fall back to array order.
            id: images[item.imageIndex ?? index]?.id ?? crypto.randomUUID(),
            description: item.description,
            tags: item.tags?.filter(Boolean),
            text: item.text?.map((t) => ({
                text: t.text,
                confidence: t.confidence
            })),
            safety: item.safety
                ? { ...item.safety, provider: AIProvider.Gemini }
                : { flagged: false, provider: AIProvider.Gemini },
            raw: item
        }));
    }
}
