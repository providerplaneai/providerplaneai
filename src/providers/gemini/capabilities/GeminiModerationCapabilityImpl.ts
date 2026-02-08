import { GoogleGenAI } from "@google/genai";
import {
    AIProvider,
    AIRequest,
    AIResponse,
    BaseProvider,
    CapabilityKeys,
    ClientModerationRequest,
    ModerationCapability,
    MultiModalExecutionContext,
    NormalizedModeration
} from "#root/index.js";

/**
 * GeminiModerationCapabilityImpl: Implements moderation for Gemini using structured response schema.
 *
 * Defines the expected structure of JSON returned by Gemini for moderation tasks.
 * Used by the SDK to validate and parse responses deterministically.
 */
const MODERATION_SCHEMA = {
    type: "OBJECT", // No SchemaType needed, just use 'OBJECT'
    properties: {
        flagged: { type: "BOOLEAN" },
        categories: {
            type: "OBJECT",
            properties: {
                sexual: { type: "BOOLEAN" },
                hate: { type: "BOOLEAN" },
                harassment: { type: "BOOLEAN" },
                self_harm: { type: "BOOLEAN" },
                violence: { type: "BOOLEAN" }
            },
            required: ["sexual", "hate", "harassment", "self_harm", "violence"]
        },
        reasoning: { type: "STRING" }
    },
    required: ["flagged", "categories"]
};

/**
 * Gemini moderation capability implementation.
 *
 * Responsibilities:
 * - Implements the unified IModerationCapability interface for Gemini
 * - Supports moderation for single or multiple inputs
 * - Uses structured response schema to ensure consistent parsing
 * - Normalizes Gemini-specific responses into provider-agnostic ModerationResult
 * - Tracks metadata and request context for observability
 */
export class GeminiModerationCapabilityImpl implements ModerationCapability<
    ClientModerationRequest,
    NormalizedModeration[]
> {
    /**
     * Constructs a new Gemini moderation capability.
     *
     * @param provider - Owning provider instance (lifecycle + config)
     * @param client - Initialized GoogleGenAI SDK client
     */
    constructor(
        private readonly provider: BaseProvider,
        private readonly client: GoogleGenAI
    ) { }

    /**
     * Executes moderation on one or more input strings.
     *
     * Flow:
     * - Validate and normalize input
     * - Initialize CapabilityExecutionContext for consistent option merging and model resolution
     * - Execute moderation requests sequentially (or in parallel if desired)
     * - Parse Gemini JSON response and convert to ModerationResult
     * - Normalize output to single result if input was single string
     *
     * @param request - Unified moderation request
     * @param _executionContext Optional execution context
     * @param signal Optional abort signal
     * @returns AIResponse containing ModerationResult(s)
     * @throws Error if input is invalid or API fails
     */
    async moderation(
        request: AIRequest<ClientModerationRequest>,
        _executionContext?: MultiModalExecutionContext,
        signal?: AbortSignal
    ): Promise<AIResponse<NormalizedModeration[]>> {
        // Ensure provider has been initialized
        this.provider.ensureInitialized();

        const { input, options, context } = request;
        // Defensive validation: require at least one input string
        if (!input?.input) {
            throw new Error("Invalid moderation input");
        }

        if (signal?.aborted) {
            throw new Error("Request aborted");
        }

        // Merge general, provider, model, and request-level options
        const merged = this.provider.getMergedOptions(CapabilityKeys.ModerationCapabilityKey, options);

        // Normalize input to array for consistent processing
        const inputs = Array.isArray(input.input) ? input.input : [input.input];

        // Execute one Gemini call per input (no hybrid abort logic)
        const responses = await Promise.all(
            inputs.map(text => {
                const prompt =
                    `Analyze the following content for safety violations. ` +
                    `Respond strictly according to policy.\n\nContent:\n"${text}"`;

                return this.client.models.generateContent(
                    {
                        model: merged.model ?? "gemini-2.5-flash-lite",
                        contents: [
                            { role: "user", parts: [{ text: prompt }] }
                        ],
                        config: {
                            responseMimeType: "application/json",
                            responseSchema: MODERATION_SCHEMA,
                            temperature: 0
                        },
                        ...(merged.modelParams ?? {}),
                        ...(merged.providerParams ?? {})
                    }
                );
            })
        );

        const normalized: NormalizedModeration[] =
            responses.map((response, index) => {
                const parsed = JSON.parse(response.text ?? "{}");

                const categories = Object.fromEntries(
                    Object.entries(parsed.categories ?? {}).map(([k, v]) => [
                        k,
                        Boolean(v)
                    ])
                );

                return {
                    id: crypto.randomUUID(),
                    flagged: Boolean(parsed.flagged),
                    categories,
                    categoryScores: undefined, // Gemini provides no confidence scores
                    reason: parsed.reasoning || undefined,
                    metadata: {
                        provider: AIProvider.Gemini,
                        model: merged.model,
                        inputIndex: index,
                        requestId: context?.requestId
                    }
                };
            });

        // Return fully normalized AIResponse
        return {
            output: normalized,
            rawResponse: responses,
            id: crypto.randomUUID(),
            metadata: {
                ...(context?.metadata ?? {}),
                provider: AIProvider.Gemini,
                model: merged.model,
                status: "completed",
                requestId: context?.requestId
            }
        };
    }
}
