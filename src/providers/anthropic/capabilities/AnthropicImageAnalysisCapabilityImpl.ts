import Anthropic from "@anthropic-ai/sdk";
import {
    AIProvider,
    AIRequest,
    AIResponse,
    AIResponseChunk,
    BaseProvider,
    CapabilityKeys,
    ClientImageAnalysisRequest,
    ClientReferenceImage,
    ImageAnalysisCapability,
    ImageAnalysisStreamCapability,
    MultiModalExecutionContext,
    NormalizedImageAnalysis
} from "#root/index.js";

const DEFAULT_ANTHROPIC_VISION_PROMPT = `
Analyze EACH image independently.

Return a JSON array.
Each array element must describe exactly one image.
Include description, tags, safety, and identified objects for each image.
Do not merge images.
Use imageIndex based on the order provided.
`;

export class AnthropicImageAnalysisCapabilityImpl
    implements ImageAnalysisCapability<ClientImageAnalysisRequest>, ImageAnalysisStreamCapability<ClientImageAnalysisRequest>
{
    constructor(
        private readonly provider: BaseProvider,
        private readonly client: Anthropic
    ) {}

    /* ------------------------------------------------------------------ */
    /* Non-streaming image analysis                                        */
    /* ------------------------------------------------------------------ */

    async analyzeImage(
        request: AIRequest<ClientImageAnalysisRequest>,
        _executionContext?: MultiModalExecutionContext,
        signal?: AbortSignal
    ): Promise<AIResponse<NormalizedImageAnalysis[]>> {
        this.provider.ensureInitialized();
        if (signal?.aborted) {
            throw new Error("Image analysis aborted before request started");
        }

        const { input, options, context } = request;
        const images = input.images ?? [];
        if (!images.length) {
            throw new Error("At least one image is required for analysis");
        }

        const merged = this.provider.getMergedOptions(CapabilityKeys.ImageAnalysisCapabilityKey, options);

        const results: NormalizedImageAnalysis[] = [];

        // Analyze images sequentially to ensure robust per-image JSON parsing
        for (const image of images) {
            if (signal?.aborted) {
                break;
            }

            const response = await this.client.messages.create(
                {
                    model: merged.model ?? "claude-sonnet-4-20250514",
                    max_tokens: merged.modelParams?.max_tokens ?? 1024,
                    messages: this.buildVisionMessages(input.prompt ?? DEFAULT_ANTHROPIC_VISION_PROMPT, [image]),
                    ...merged.modelParams,
                    ...merged.providerParams
                },
                { signal }
            );

            const text = this.extractText(response);
            const parsed = this.normalizeAnalyses(this.stripJsonFences(text), image.id);

            results.push(...parsed);
        }

        return {
            output: results,
            rawResponse: null, // multiple underlying responses
            id: context?.requestId ?? crypto.randomUUID(),
            metadata: {
                ...(context?.metadata ?? {}),
                provider: AIProvider.Anthropic,
                model: merged.model,
                status: "completed",
                requestId: context?.requestId
            }
        };
    }

    /* ------------------------------------------------------------------ */
    /* Streaming image analysis                                            */
    /* ------------------------------------------------------------------ */

    async *analyzeImageStream(
        request: AIRequest<ClientImageAnalysisRequest>,
        _executionContext?: MultiModalExecutionContext,
        signal?: AbortSignal
    ): AsyncGenerator<AIResponseChunk<NormalizedImageAnalysis[]>> {
        this.provider.ensureInitialized();

        const { input, options, context } = request;
        const images = input.images ?? [];
        if (!images.length) {
            throw new Error("At least one image is required for analysis");
        }

        const merged = this.provider.getMergedOptions(CapabilityKeys.ImageAnalysisStreamCapabilityKey, options);

        // Sequentially stream each image for robustness
        for (const image of images) {
            if (signal?.aborted) {
                return;
            }

            let responseId: string | undefined;
            let accumulatedText = "";

            try {
                const stream = await this.client.messages.stream(
                    {
                        model: merged.model ?? "claude-sonnet-4-20250514",
                        max_tokens: merged.modelParams?.max_tokens ?? 1024,
                        messages: this.buildVisionMessages(input.prompt ?? DEFAULT_ANTHROPIC_VISION_PROMPT, [image]),
                        ...merged.modelParams,
                        ...merged.providerParams
                    },
                    { signal }
                );

                for await (const event of stream) {
                    if (signal?.aborted) {
                        return;
                    }

                    if (event.type === "message_start") {
                        responseId ??= event.message?.id;
                    }

                    if (event.type === "content_block_delta" && event.delta?.type === "text_delta") {
                        accumulatedText += event.delta.text;

                        // Yield delta as partial output
                        yield {
                            delta: [
                                {
                                    id: responseId ?? crypto.randomUUID(),
                                    description: event.delta.text,
                                    sourceImageId: image.id
                                }
                            ],
                            output: this.normalizeAnalyses(this.stripJsonFences(accumulatedText), image.id),
                            done: false,
                            id: responseId ?? crypto.randomUUID(),
                            metadata: {
                                ...(context?.metadata ?? {}),
                                provider: AIProvider.Anthropic,
                                model: merged.model,
                                status: "incomplete",
                                requestId: context?.requestId
                            }
                        };
                    }
                }

                // Final normalized analysis
                const analyses = this.normalizeAnalyses(this.stripJsonFences(accumulatedText), image.id);

                yield {
                    delta: [],
                    output: analyses,
                    done: true,
                    id: responseId ?? crypto.randomUUID(),
                    metadata: {
                        ...(context?.metadata ?? {}),
                        provider: AIProvider.Anthropic,
                        model: merged.model,
                        status: "completed",
                        requestId: context?.requestId
                    }
                };
            } catch (err) {
                if (signal?.aborted) {
                    return;
                }

                yield {
                    delta: [],
                    output: [],
                    done: true,
                    id: responseId ?? crypto.randomUUID(),
                    metadata: {
                        ...(context?.metadata ?? {}),
                        provider: AIProvider.Anthropic,
                        model: merged.model,
                        status: "error",
                        requestId: context?.requestId,
                        error: err instanceof Error ? err.message : String(err),
                        sourceImageId: image.id
                    }
                };
            }
        }
    }

    /* ------------------------------------------------------------------ */
    /* Helpers                                                             */
    /* ------------------------------------------------------------------ */

    private normalizeAnalyses(payload: string | unknown, sourceImageId?: string): NormalizedImageAnalysis[] {
        let root: any;

        if (typeof payload === "string") {
            try {
                root = JSON.parse(payload);
            } catch {
                return [];
            }
        } else {
            root = payload;
        }

        if (!root) {
            return [];
        }

        const items = Array.isArray(root) ? root : [root];

        return items.map((item: any) => {
            // 1️ Description
            let description = item.description;
            if (!description || typeof description !== "string") {
                const strings: string[] = [];
                const walk = (v: unknown) => {
                    if (typeof v === "string" && v.trim()) {
                        strings.push(v.trim());
                    } else if (Array.isArray(v)) {
                        v.forEach(walk);
                    } else if (v && typeof v === "object") {
                        Object.values(v).forEach(walk);
                    }
                };
                walk(item);
                description = strings.shift() ?? undefined;
            }

            // 2️ Tags
            let tags: string[] | undefined;

            if (Array.isArray(item.tags) && item.tags.length > 0) {
                tags = item.tags.filter((t: unknown): t is string => typeof t === "string" && t.trim().length > 0);
            }

            // Fallback: derive tags from any other arrays in the object
            if (!tags || tags.length === 0) {
                tags = [];
                Object.values(item).forEach((v: unknown) => {
                    if (Array.isArray(v)) {
                        v.forEach((e: unknown) => {
                            if (typeof e === "string" && e.trim().length > 3 && e.trim().length < 40) {
                                tags!.push(e.trim());
                            }
                        });
                    }
                });
            }

            // Final fallback: split description into phrases
            if (!tags || tags.length === 0) {
                if (typeof description === "string") {
                    tags = Array.from(
                        new Set(
                            description
                                .split(/[,.;]/)
                                .map((s) => s.trim())
                                .filter((s) => s.length > 3 && s.length < 40)
                        )
                    );
                }
            }

            // 3️. Objects: mirror tags if objects are missing
            let objects: { label: string }[] | undefined;
            if (Array.isArray(item.objects) && item.objects.length > 0) {
                objects = item.objects
                    .filter((o: any) => o && typeof o.label === "string")
                    .map((o: any) => ({ label: o.label }));
            } else if (tags && tags.length > 0) {
                objects = tags.map((t) => ({ label: t }));
            }
            return {
                id: crypto.randomUUID(),
                sourceImageId,
                description,
                tags: tags?.length ? tags : undefined,
                objects: objects?.length ? objects : undefined,
                safety: { flagged: item.safety !== "safe" }
            };
        });
    }

    private extractText(message: any): string {
        return (message?.content ?? [])
            .filter((c: any) => c.type === "text")
            .map((c: any) => c.text)
            .join("");
    }

    private buildVisionMessages(prompt: string, images: ClientReferenceImage[]): any[] {
        if (!prompt) {
            throw new Error("Vision prompt is required");
        }

        const content: any[] = [];

        // Primary prompt
        content.push({ type: "text", text: prompt });

        for (const img of images) {
            if (img.sourceType !== "base64" || !img.base64) {
                throw new Error(`Anthropic vision requires base64 images (got ${img.sourceType})`);
            }

            if (img.description) {
                content.push({ type: "text", text: img.description });
            }

            content.push({
                type: "image",
                source: { type: "base64", media_type: img.mimeType ?? "image/png", data: img.base64 }
            });
        }

        return [{ role: "user", content }];
    }

    private stripJsonFences(text: string): string {
        const trimmed = text.trim();
        if (trimmed.startsWith("```") && trimmed.endsWith("```")) {
            return trimmed
                .replace(/^```(?:json)?\s*/i, "")
                .replace(/\s*```$/, "")
                .trim();
        }
        return trimmed;
    }
}
