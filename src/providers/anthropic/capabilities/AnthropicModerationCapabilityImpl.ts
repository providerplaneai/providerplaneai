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
    NormalizedModeration
} from "#root/index.js";

/**
 * AnthropicModerationCapabilityImpl: Implements moderation for Anthropic via structured prompt and JSON response.
 *
 * Claude does not provide a native moderation API; moderation is performed via a structured prompt and JSON response.
 * This interface represents the expected JSON schema.
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
 * Anthropic-specific moderation result format.
 *
 * Claude does not provide a native moderation API, so moderation
 * is performed via a structured prompt and JSON response.
 * This interface represents the expected JSON schema.
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
 * Anthropic moderation capability implementation.
 *
 * Important:
 * Anthropic does NOT expose a native moderation endpoint.
 * This implementation performs moderation by:
 * - Prompting Claude with a structured moderation instruction
 * - Parsing deterministic JSON output
 * - Normalizing results into a provider-agnostic ModerationResult
 */
export class AnthropicModerationCapabilityImpl implements ModerationCapability<
    ClientModerationRequest,
    NormalizedModeration[]
> {
    /**
     * @param provider - Parent provider instance (for lifecycle + config access)
     * @param client - Initialized Anthropic SDK client
     */
    constructor(
        private readonly provider: BaseProvider,
        private readonly client: Anthropic
    ) {}

    /**
     * Performs moderation on one or more input strings.
     *
     * Responsibilities:
     * - Validate and normalize input
     * - Resolve merged model and provider options
     * - Execute moderation prompts in parallel
     * - Parse and normalize structured JSON responses
     * - Aggregate token usage and metadata
     *
     * @template TModerationInput
     * @param request - Unified moderation request
     * @param _executionContext Optional execution context
     * @param signal Optional abort signal
     * @returns AIResponse containing moderation result(s)
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
                metadata: {
                    provider: AIProvider.Anthropic,
                    model: merged.model,
                    inputIndex: index,
                    requestId: context?.requestId
                }
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
            metadata: {
                ...(context?.metadata ?? {}),
                provider: AIProvider.Anthropic,
                model: merged.model,
                status: "completed",
                tokensUsed: totalTokens,
                requestId: context?.requestId
            }
        };
    }
}
