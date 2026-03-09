/**
 * @module providers/gemini/capabilities/GeminiImageAnalysisCapabilityImpl.ts
 * @description Provider implementations and capability adapters.
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
/**
 * @public
 * @description Provider capability implementation for GeminiImageAnalysisCapabilityImpl.
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

        const contents = [
            {
                role: "user",
                parts: [{ text: prompt }, ...images.map((img) => this.toGeminiImagePart(img))]
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

        const responseText = this.extractGeminiResponseText(response);
        const parsed = parseBestEffortJson<GeminiImageAnalysisPayload>(this.stripMarkdownCodeFence(responseText));
        const normalized = this.normalizeGeminiAnalyses(parsed, images, responseText);

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
                countsMatch: normalized.length === images.length
            }
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
                contents: [
                    {
                        role: "user",
                        parts: [{ text: prompt }, ...images.map((img) => this.toGeminiImagePart(img))]
                    }
                ],
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
                metadata: {
                    ...(context?.metadata ?? {}),
                    provider: AIProvider.Gemini,
                    model: merged.model,
                    status: "completed",
                    requestId: context?.requestId,
                    countsMatch: normalized.length === images.length
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
        const mimeType = img.mimeType ?? "image/png";

        if (typeof img.base64 === "string" && img.base64.length > 0) {
            return {
                inlineData: {
                    mimeType,
                    data: this.stripDataUriPrefix(img.base64)
                }
            };
        }

        if (typeof img.url === "string" && img.url.length > 0) {
            // Data URIs are not valid fileUri values for Gemini; convert them to inlineData.
            if (img.url.startsWith("data:")) {
                const parsed = this.parseDataUri(img.url);
                return {
                    inlineData: {
                        mimeType: parsed.mimeType ?? mimeType,
                        data: parsed.base64
                    }
                };
            }

            return {
                fileData: {
                    mimeType,
                    fileUri: img.url
                }
            };
        }

        throw new Error("Gemini image analysis requires image.base64 or image.url");
    }

    /**
     * Strips `data:<mime>;base64,` when present.
     */
    private stripDataUriPrefix(value: string): string {
        const marker = "base64,";
        const idx = value.toLowerCase().indexOf(marker);
        if (idx >= 0) {
            return value.slice(idx + marker.length).trim();
        }
        return value.trim();
    }

    private parseDataUri(dataUri: string): { mimeType?: string; base64: string } {
        const match = dataUri.match(/^data:([^;,]+)?(?:;base64)?,(.*)$/i);
        if (!match) {
            return { base64: this.stripDataUriPrefix(dataUri) };
        }
        return {
            mimeType: match[1],
            base64: (match[2] ?? "").trim()
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

        const candidateTexts =
            response?.candidates
                ?.flatMap((candidate: any) => candidate?.content?.parts ?? [])
                ?.map((part: any) => (typeof part?.text === "string" ? part.text : ""))
                ?.filter((t: string) => t.length > 0) ?? [];

        return candidateTexts.join("\n");
    }

    /**
     * Gemini may wrap JSON in markdown code fences. Remove a single outer fence block.
     */
    private stripMarkdownCodeFence(value: string): string {
        const trimmed = value.trim();
        const match = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
        return match?.[1]?.trim() ?? trimmed;
    }
}
