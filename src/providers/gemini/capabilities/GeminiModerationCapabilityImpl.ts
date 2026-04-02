/**
 * @module providers/gemini/capabilities/GeminiModerationCapabilityImpl.ts
 * @description Gemini moderation capability adapter.
 */
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
    NormalizedModeration,
    buildMetadata
} from "#root/index.js";

const DEFAULT_GEMINI_MODERATION_MODEL = "gemini-2.5-flash-lite";

/**
 * JSON schema used to constrain Gemini moderation responses.
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
 * Adapts Gemini moderation responses into ProviderPlaneAI's normalized moderation artifact surface.
 *
 * Gemini does not expose a dedicated moderation endpoint, so this adapter uses a
 * structured JSON generation prompt and normalizes the parsed result.
 *
 * @public
 */
export class GeminiModerationCapabilityImpl implements ModerationCapability<ClientModerationRequest, NormalizedModeration[]> {
    /**
     * Creates a new Gemini moderation capability adapter.
     *
     * @param {BaseProvider} provider Owning provider instance used for initialization checks and merged config access.
     * @param {GoogleGenAI} client Initialized Google GenAI SDK client.
     */
    constructor(
        private readonly provider: BaseProvider,
        private readonly client: GoogleGenAI
    ) {}

    /**
     * Executes a Gemini moderation request.
     *
     * Responsibilities:
     * - validate moderation input
     * - resolve merged model/runtime options
     * - execute one structured moderation request per input string
     * - parse Gemini JSON output into normalized moderation artifacts
     * - attach provider/model/request metadata
     *
     * @param {AIRequest<ClientModerationRequest>} request Unified moderation request envelope.
     * @param {MultiModalExecutionContext} [_executionContext] Optional execution context. Unused directly in this adapter.
     * @param {AbortSignal} [signal] Optional cancellation signal.
     * @returns {Promise<AIResponse<NormalizedModeration[]>>} Provider-normalized moderation artifacts.
     * @throws {Error} When input is invalid or the provider call fails.
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
            inputs.map((text) => {
                const prompt =
                    `Analyze the following content for safety violations. ` +
                    `Respond strictly according to policy.\n\nContent:\n"${text}"`;

                return this.client.models.generateContent({
                    model: merged.model ?? DEFAULT_GEMINI_MODERATION_MODEL,
                    contents: [{ role: "user", parts: [{ text: prompt }] }],
                    config: {
                        responseMimeType: "application/json",
                        responseSchema: MODERATION_SCHEMA,
                        temperature: 0
                    },
                    ...(merged.modelParams ?? {}),
                    ...(merged.providerParams ?? {})
                });
            })
        );

        const normalized: NormalizedModeration[] = responses.map((response, index) => {
            const parsed = JSON.parse(response.text ?? "{}");

            const categories = Object.fromEntries(Object.entries(parsed.categories ?? {}).map(([k, v]) => [k, Boolean(v)]));

            return {
                id: crypto.randomUUID(),
                flagged: Boolean(parsed.flagged),
                categories,
                categoryScores: undefined, // Gemini provides no confidence scores
                reason: parsed.reasoning || undefined,
                metadata: buildMetadata(undefined, {
                    provider: AIProvider.Gemini,
                    model: merged.model,
                    inputIndex: index,
                    requestId: context?.requestId
                })
            };
        });

        // Return fully normalized AIResponse
        return {
            output: normalized,
            rawResponse: responses,
            id: crypto.randomUUID(),
            metadata: buildMetadata(context?.metadata, {
                provider: AIProvider.Gemini,
                model: merged.model,
                status: "completed",
                requestId: context?.requestId
            })
        };
    }
}
