import Anthropic from "@anthropic-ai/sdk";
import {
    AIProvider,
    AIRequest,
    AIResponse,
    BaseProvider,
    CapabilityKeys,
    ClientModerationRequest,
    ModerationCapability,
    ModerationResult,
    MultiModalExecutionContext
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
    ModerationResult | ModerationResult[]
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
     * @returns AIResponse containing moderation result(s)
     */
    async moderation(
        request: AIRequest<ClientModerationRequest>,
        _executionContext?: MultiModalExecutionContext
    ): Promise<AIResponse<ModerationResult | ModerationResult[]>> {
        // Ensure provider has been initialized
        this.provider.ensureInitialized();

        const { input, options, context } = request;

        // Defensive validation: Requires at least one input string
        if (!input?.input || (Array.isArray(input.input) && input.input.length === 0)) {
            throw new Error("Invalid moderation input");
        }

        // Merge general, provider, model, and request-level options
        const merged = this.provider.getMergedOptions(CapabilityKeys.ModerationCapabilityKey, options);

        //Normalize input into array form. This simplifies parallel execution and consistent output normalization.
        const inputs = Array.isArray(input.input) ? input.input : [input.input];

        // Execute moderation requests in parallel
        const moderationPromises = inputs.map(async (content) => {
            const message = await this.client.messages.create({
                model: merged.model ?? "claude-sonnet-4-20250514",
                max_tokens: merged.modelParams?.max_tokens ?? 1024,
                messages: [
                    {
                        role: "user",
                        content: MODERATION_PROMPT.replace("{{CONTENT}}", content)
                    }
                ],
                ...(merged.modelParams ?? {}),
                ...(merged.providerParams ?? {})
            });

            // Extract text content from Claude's response
            const textContent = message.content.find((block) => block.type === "text");
            if (!textContent || textContent.type !== "text") {
                throw new Error("No text response from Claude");
            }

            // Parse the JSON response, stripping any markdown fences
            const cleanedText = textContent.text
                .replace(/```json\n?/g, "")
                .replace(/```\n?/g, "")
                .trim();

            const anthropicResult: AnthropicModerationResult = JSON.parse(cleanedText);

            // Convert to provider-agnostic ModerationResult
            const moderationResult: ModerationResult = {
                flagged: anthropicResult.flagged,
                categories: anthropicResult.categories,
                // Claude does not provide confidence scores,
                // so we use binary scores for compatibility.
                categoryScores: Object.fromEntries(
                    Object.entries(anthropicResult.categories).map(([key, flagged]) => [
                        key,
                        flagged ? 1.0 : 0.0 // Binary scores since Claude doesn't provide confidence scores
                    ])
                ),
                reason: anthropicResult.explanation,
                raw: {
                    ...anthropicResult,
                    messageId: message.id,
                    usage: message.usage
                }
            };

            return moderationResult;
        });

        // Wait for all moderation requests to complete
        const results = await Promise.all(moderationPromises);

        // Normalize output: single input -> single result, array input -> array results
        const normalizedOutput = Array.isArray(input.input) ? results : results[0];

        // Calculate total tokens used across all requests
        const totalTokens = results.reduce((sum, r) => {
            const usage = (r.raw as any)?.usage;
            if (!usage) {
                return sum;
            }
            return sum + (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0);
        }, 0);

        // Return a fully normalized response
        return {
            output: normalizedOutput,
            rawResponse: results.map((r) => r.raw),
            id: results[0]?.raw?.messageId ?? "unknown",
            metadata: {
                provider: AIProvider.Anthropic,
                model: merged.model,
                status: "completed",
                tokensUsed: totalTokens,
                requestId: context?.requestId,
                ...(context?.metadata ?? {})
            }
        };
    }
}
