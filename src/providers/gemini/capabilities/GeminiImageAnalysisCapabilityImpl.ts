import { GoogleGenAI } from "@google/genai";
import {
    AIProvider,
    AIRequest,
    AIResponse,
    BaseProvider,
    CapabilityKeys,
    ClientImageAnalysisRequest,
    ImageAnalysisCapability,
    MultiModalExecutionContext,
    NormalizedImageAnalysis
} from "#root/index.js";

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
 *
 * @template TRequest Image analysis request type
 */
export class GeminiImageAnalysisCapabilityImpl implements ImageAnalysisCapability<ClientImageAnalysisRequest> {
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
     * @param _executionContext Optional execution context
     * @returns Provider-agnostic normalized image analysis results
     */
    async analyzeImage(
        request: AIRequest<ClientImageAnalysisRequest>,
        _executionContext?: MultiModalExecutionContext
    ): Promise<AIResponse<NormalizedImageAnalysis[]>> {
        // Ensure the provider has credentials and is initialized
        this.provider.ensureInitialized();

        const { input, options, context } = request;
        const images = input.images ?? [];

        if (!images.length) {
            throw new Error("At least one image is required for analysis");
        }

        // Merge general, provider, model, and request-level options
        const merged = this.provider.getMergedOptions(CapabilityKeys.ImageAnalysisCapabilityKey, options);

        const analyses: NormalizedImageAnalysis[] = [];
        let response = null;
        let rawText = "";
        let responseId = null;

        // Process each image individually
        for (const img of images) {
            try {
                // Call Gemini multimodal model
                response = await this.client.models.generateContent({
                    model: merged.model ?? "gemini-2.5-pro",
                    contents: [
                        {
                            role: "user",
                            parts: [
                                { text: prompt },
                                {
                                    inlineData: {
                                        mimeType: img.mimeType ?? "image/png",
                                        data: img.base64!
                                    }
                                }
                            ]
                        }
                    ],
                    config: {
                        temperature: 0,
                        ...(merged.modelParams ?? {})
                    },
                    ...(merged.providerParams ?? {})
                });

                // Capture first response id (if returned)
                if (!responseId && response.responseId) {
                    responseId = response.responseId;
                }

                // Text block is what we need to parse as JSON
                rawText = response.text ?? "";
                // Parse the model's text output as JSON
                const parsed = JSON.parse(rawText) as NormalizedImageAnalysis;
                // Push normalized result with provider metadata
                analyses.push({
                    ...parsed,
                    id: img.id,
                    raw: response
                });
            } catch {
                // Fallback: wrap whatever text we got as description
                analyses.push({
                    id: img.id,
                    description: rawText,
                    raw: response
                });
            }
        }
        // Return provider-agnostic normalized response.
        return {
            output: analyses,
            rawResponse: response,
            id: responseId ?? "unknown",
            metadata: {
                provider: AIProvider.Gemini,
                model: merged.model,
                status: "completed",
                requestId: context?.requestId,
                ...(context?.metadata ?? {})
            }
        };
    }
}
