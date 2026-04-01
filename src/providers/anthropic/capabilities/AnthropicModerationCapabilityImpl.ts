/**
 * @module providers/anthropic/capabilities/AnthropicModerationCapabilityImpl.ts
 * @description Anthropic moderation capability adapter.
 */
import Anthropic from "@anthropic-ai/sdk";
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

/**
 * Parsed moderation shape returned by Claude for structured moderation prompts.
 */
interface AnthropicModerationResult {
    flagged: boolean;
    categories: {
        hate: boolean;
        violence: boolean;
        sexual: boolean;
        harassment: boolean;
        illegal: boolean;
        spam: boolean;
    };
    severity: "low" | "medium" | "high" | "none";
    explanation: string;
}

/**
 * Prompt template used to coerce Claude into a deterministic moderation JSON response.
 */
const MODERATION_PROMPT = `You are a content moderator. Analyze the following user content and determine if it violates any policies.

Check for the following categories:
- Hate speech or discrimination (hate)
- Violence or threats (violence)
- Sexual content (sexual)
- Harassment or bullying (harassment)
- Illegal activities (illegal)
- Spam or scams (spam)

Respond ONLY with a valid JSON object (no markdown, no preamble) with this exact structure:
{
  "flagged": boolean,
  "categories": {
    "hate": boolean,
    "violence": boolean,
    "sexual": boolean,
    "harassment": boolean,
    "illegal": boolean,
    "spam": boolean
  },
  "severity": "low" | "medium" | "high" | "none",
  "explanation": "Brief explanation of the decision"
}

User content to moderate: {{CONTENT}}`;
const DEFAULT_ANTHROPIC_MODERATION_MODEL = "claude-sonnet-4-20250514";

/**
 * Adapts Anthropic moderation responses into ProviderPlaneAI's normalized moderation artifact surface.
 *
 * Anthropic does not expose a native moderation endpoint, so this adapter prompts
 * Claude for deterministic JSON and normalizes the parsed result.
 *
 * @public
 */
export class AnthropicModerationCapabilityImpl implements ModerationCapability<
    ClientModerationRequest,
    NormalizedModeration[]
> {
    /**
     * Creates a new Anthropic moderation capability adapter.
     *
     * @param {BaseProvider} provider Parent provider instance used for initialization checks and merged config access.
     * @param {Anthropic} client Initialized Anthropic SDK client.
     */
    constructor(
        private readonly provider: BaseProvider,
        private readonly client: Anthropic
    ) {}

    /**
     * Executes an Anthropic moderation request.
     *
     * Responsibilities:
     * - validate moderation input
     * - resolve merged model/runtime options
     * - execute one Claude moderation prompt per input string
     * - parse deterministic JSON output into normalized moderation artifacts
     * - aggregate token usage and attach provider/request metadata
     *
     * @param {AIRequest<ClientModerationRequest>} request Unified moderation request envelope.
     * @param {MultiModalExecutionContext} [_executionContext] Optional execution context. Unused directly in this adapter.
     * @param {AbortSignal} [signal] Optional cancellation signal.
     * @returns {Promise<AIResponse<NormalizedModeration[]>>} Provider-normalized moderation artifacts.
     * @throws {Error} When input is invalid, aborted, or Claude returns no text moderation payload.
     */
    async moderation(
        request: AIRequest<ClientModerationRequest>,
        _executionContext?: MultiModalExecutionContext,
        signal?: AbortSignal
    ): Promise<AIResponse<NormalizedModeration[]>> {
        // Ensure provider has been initialized
        this.provider.ensureInitialized();

        const { input, options, context } = request;

        // Defensive validation: Requires at least one input string
        if (!input?.input || (Array.isArray(input.input) && input.input.length === 0)) {
            throw new Error("Invalid moderation input");
        }

        if (signal?.aborted) {
            throw new Error("Request aborted");
        }

        // Merge general, provider, model, and request-level options
        const merged = this.provider.getMergedOptions(CapabilityKeys.ModerationCapabilityKey, options);

        //Normalize input into array form. This simplifies parallel execution and consistent output normalization.
        const inputs = Array.isArray(input.input) ? input.input : [input.input];

        // Execute one Claude call per input (Anthropic limitation)
        const responses = await Promise.all(
            inputs.map((content) =>
                this.client.messages.create(
                    {
                        model: merged.model ?? DEFAULT_ANTHROPIC_MODERATION_MODEL,
                        max_tokens: merged.modelParams?.max_tokens ?? 512,
                        messages: [
                            {
                                role: "user",
                                content: MODERATION_PROMPT.replace("{{CONTENT}}", content)
                            }
                        ],
                        ...(merged.modelParams ?? {}),
                        ...(merged.providerParams ?? {})
                    },
                    { signal }
                )
            )
        );

        const normalized: NormalizedModeration[] = responses.map((response, index) => {
            const textBlock = response.content.find((b) => b.type === "text");
            if (!textBlock || textBlock.type !== "text") {
                throw new Error("Anthropic moderation returned no text");
            }

            const parsed: AnthropicModerationResult = JSON.parse(
                textBlock.text
                    .replace(/```json\n?/g, "")
                    .replace(/```\n?/g, "")
                    .trim()
            );

            const categoryScores = Object.fromEntries(Object.entries(parsed.categories).map(([k, v]) => [k, v ? 1.0 : 0.0]));

            return {
                id: crypto.randomUUID(),
                flagged: parsed.flagged,
                categories: parsed.categories,
                categoryScores,
                reason: parsed.explanation || undefined,
                metadata: buildMetadata(undefined, {
                    provider: AIProvider.Anthropic,
                    model: merged.model,
                    inputIndex: index,
                    requestId: context?.requestId
                })
            };
        });

        const totalTokens = responses.reduce((sum, r) => {
            if (!r.usage) {
                return sum;
            }
            return sum + (r.usage.input_tokens ?? 0) + (r.usage.output_tokens ?? 0);
        }, 0);

        // Return a fully normalized response
        return {
            output: normalized,
            rawResponse: responses,
            id: crypto.randomUUID(),
            metadata: buildMetadata(context?.metadata, {
                provider: AIProvider.Anthropic,
                model: merged.model,
                status: "completed",
                tokensUsed: totalTokens,
                requestId: context?.requestId
            })
        };
    }
}
