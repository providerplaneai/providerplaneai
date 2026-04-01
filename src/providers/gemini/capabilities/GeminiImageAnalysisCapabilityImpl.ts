/**
 * @module providers/gemini/capabilities/GeminiImageAnalysisCapabilityImpl.ts
 * @description Gemini image-analysis capability adapter built on multimodal generation.
 */
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
    parseBestEffortJson,
    resolveReferenceMediaSource,
    buildMetadata
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
 * Adapts Gemini image analysis responses into ProviderPlaneAI's normalized image-analysis artifact surface.
 *
 * Uses Gemini multimodal generation to analyze images and returns best-effort
 * structured results by prompting the model to emit strict JSON.
 *
 * NOTE:
 * - Gemini does not support tool/function calling in this path
 * - JSON structure is enforced via prompting only
 * - Bounding boxes and confidence scores are optional / best-effort
 *
 * @public
 */
export class GeminiImageAnalysisCapabilityImpl
    implements ImageAnalysisCapability<ClientImageAnalysisRequest>, ImageAnalysisStreamCapability<ClientImageAnalysisRequest>
{
    /**
     * @param {BaseProvider} provider - Parent provider instance.
     * @param {GoogleGenAI} client - Initialized GoogleGenAI client.
     */
    constructor(
        private readonly provider: BaseProvider,
        private readonly client: GoogleGenAI
    ) {}

    /**
     * Analyze one or more images using Gemini multimodal models.
     *
     * @param {AIRequest<ClientImageAnalysisRequest>} request - Unified AI request containing images to analyze.
     * @param {MultiModalExecutionContext | undefined} executionContext - Optional execution context.
     * @param {AbortSignal | undefined} signal - Optional abort signal.
     * @returns {Promise<AIResponse<NormalizedImageAnalysis[]>>} Provider-agnostic normalized image-analysis results.
     */
    async analyzeImage(
        request: AIRequest<ClientImageAnalysisRequest>,
        executionContext?: MultiModalExecutionContext,
        signal?: AbortSignal
    ): Promise<AIResponse<NormalizedImageAnalysis[]>> {
        this.provider.ensureInitialized();

        const { input, options, context } = request;

        const contextImages = executionContext?.getLatestImages() ?? [];
        const images = input.images ?? contextImages ?? [];

        if (!images.length) {
            throw new Error("At least one image is required for analysis");
        }

        if (signal?.aborted) {
            throw new Error("Request aborted");
        }

        const merged = this.provider.getMergedOptions(CapabilityKeys.ImageAnalysisCapabilityKey, options);

        const contents = [this.buildGeminiUserContent(images)];

        const response = await this.client.models.generateContent({
            model: merged.model ?? DEFAULT_GEMINI_IMAGE_ANALYSIS_MODEL,
            contents,
            config: {
                temperature: 0,
                ...(merged.modelParams ?? {})
            },
            ...(merged.providerParams ?? {})
        });

        const responseText = this.extractGeminiResponseText(response);
        const parsed = parseBestEffortJson<GeminiImageAnalysisPayload>(this.stripMarkdownCodeFence(responseText));
        const normalized = this.normalizeGeminiAnalyses(parsed, images, responseText);

        return {
            output: normalized,
            rawResponse: response,
            id: response.responseId ?? context?.requestId ?? crypto.randomUUID(),
            metadata: buildMetadata(context?.metadata, {
                provider: AIProvider.Gemini,
                model: merged.model,
                status: "completed",
                requestId: context?.requestId,
                countsMatch: normalized.length === images.length
            })
        };
    }

    /**
     * Analyze images with streaming output using Gemini.
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
                contents: [this.buildGeminiUserContent(images)],
                config: {
                    temperature: 0,
                    ...(merged.modelParams ?? {})
                },
                ...(merged.providerParams ?? {})
            });

            for await (const chunk of stream) {
                if (signal?.aborted) {
                    throw new Error("Request aborted");
                }
                responseId ??= chunk.responseId;
                if (chunk.text) {
                    accumulatedText += chunk.text;
                }
            }

            const parsed = parseBestEffortJson<GeminiImageAnalysisPayload>(this.stripMarkdownCodeFence(accumulatedText));
            const normalized = this.normalizeGeminiAnalyses(parsed, images, accumulatedText);

            yield {
                output: normalized,
                delta: normalized,
                done: true,
                id: responseId ?? crypto.randomUUID(),
                metadata: buildMetadata(context?.metadata, {
                    provider: AIProvider.Gemini,
                    model: merged.model,
                    status: "completed",
                    requestId: context?.requestId,
                    countsMatch: normalized.length === images.length
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
                    model: merged.model,
                    status: "error",
                    requestId: context?.requestId,
                    error: err instanceof Error ? err.message : String(err)
                })
            };
        }
    }

    private normalizeGeminiAnalyses(
        payload: GeminiImageAnalysisPayload | GeminiImageAnalysisPayload[],
        images: { id?: string }[],
        rawText?: string
    ): NormalizedImageAnalysis[] {
        let items = Array.isArray(payload) ? payload : [payload];

        // If structured JSON parsing produced an empty payload, keep the raw text as description
        // so callers still get useful analysis output.
        if (this.isEffectivelyEmptyPayload(items) && typeof rawText === "string" && rawText.trim().length > 0) {
            items = [{ description: rawText.trim() }];
        }

        return items.map((item, index) => ({
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

    private isEffectivelyEmptyPayload(items: GeminiImageAnalysisPayload[]): boolean {
        if (!items.length) {
            return true;
        }

        return items.every((item) => {
            const hasDescription = typeof item.description === "string" && item.description.trim().length > 0;
            const hasTags =
                Array.isArray(item.tags) && item.tags.some((tag) => typeof tag === "string" && tag.trim().length > 0);
            const hasText =
                Array.isArray(item.text) && item.text.some((t) => typeof t?.text === "string" && t.text.trim().length > 0);
            const hasSafety = typeof item.safety?.flagged === "boolean";

            return !hasDescription && !hasTags && !hasText && !hasSafety;
        });
    }

    /**
     * Converts provider-agnostic image input into Gemini content part shape.
     */
    private toGeminiImagePart(img: { base64?: string; url?: string; mimeType?: string }) {
        const resolved = resolveReferenceMediaSource(
            img,
            "image/png",
            "Gemini image analysis requires image.base64 or image.url"
        );

        if (resolved.kind === "base64") {
            return {
                inlineData: {
                    mimeType: resolved.mimeType,
                    data: resolved.base64
                }
            };
        }

        return {
            fileData: {
                mimeType: resolved.mimeType,
                fileUri: resolved.url
            }
        };
    }

    /**
     * Gemini can place text in either top-level `text` or nested candidate parts.
     * Prefer top-level text, then fall back to concatenated candidate-part text.
     */
    private extractGeminiResponseText(response: any): string {
        if (typeof response?.text === "string" && response.text.length > 0) {
            return response.text;
        }

        let text = "";
        const candidates = response?.candidates;
        if (!Array.isArray(candidates)) {
            return "";
        }

        for (const candidate of candidates) {
            const parts = candidate?.content?.parts;
            if (!Array.isArray(parts)) {
                continue;
            }
            for (const part of parts) {
                if (typeof part?.text === "string" && part.text.length > 0) {
                    text += text.length > 0 ? `\n${part.text}` : part.text;
                }
            }
        }

        return text;
    }

    /**
     * Gemini may wrap JSON in markdown code fences. Remove a single outer fence block.
     */
    private stripMarkdownCodeFence(value: string): string {
        const trimmed = value.trim();
        const match = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
        return match?.[1]?.trim() ?? trimmed;
    }

    private buildGeminiUserContent(images: Array<{ base64?: string; url?: string; mimeType?: string }>): {
        role: "user";
        parts: Array<
            | { text: string }
            | { inlineData: { mimeType: string; data: string } }
            | { fileData: { mimeType: string; fileUri: string } }
        >;
    } {
        const parts = new Array(images.length + 1) as Array<
            | { text: string }
            | { inlineData: { mimeType: string; data: string } }
            | { fileData: { mimeType: string; fileUri: string } }
        >;
        parts[0] = { text: prompt };
        for (let i = 0; i < images.length; i++) {
            parts[i + 1] = this.toGeminiImagePart(images[i]);
        }
        return { role: "user", parts };
    }
}
