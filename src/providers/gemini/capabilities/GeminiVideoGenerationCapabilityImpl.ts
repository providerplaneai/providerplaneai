/**
 * @module providers/gemini/capabilities/GeminiVideoGenerationCapabilityImpl.ts
 * @description Gemini video generation capability adapter.
 */
import { GoogleGenAI } from "@google/genai";
import {
    AIRequest,
    AIResponse,
    BaseProvider,
    CapabilityKeys,
    ClientVideoGenerationRequest,
    MultiModalExecutionContext,
    NormalizedVideo,
    resolveReferenceMediaUrl,
    resolveImageToBytes,
    VideoGenerationCapability
} from "#root/index.js";
import {
    buildGeminiVideoArtifact,
    buildGeminiVideoResponseMetadata,
    extractGeneratedVideoOrThrow,
    resolveGeminiOperationId,
    resolveGeminiDurationSeconds,
    resolveGeminiOperationResult,
    resolveGeminiVideoBase64,
    resolveGeminiVideoExecutionControls,
    throwIfGeminiOperationFailed
} from "#root/providers/gemini/capabilities/shared/GeminiVideoUtils.js";

const DEFAULT_GEMINI_VIDEO_MODEL = "veo-3.1-generate-preview";
const GEMINI_VIDEO_MIN_DURATION_SECONDS = 4;
const GEMINI_VIDEO_MAX_DURATION_SECONDS = 8;

/**
 * Gemini video generation capability implementation.
 *
 * Uses Gemini's long-running video generation API, optionally polls until the
 * operation completes, and normalizes the generated video into
 * `NormalizedVideo[]`.
 *
 * @public
 */
export class GeminiVideoGenerationCapabilityImpl implements VideoGenerationCapability<
    ClientVideoGenerationRequest,
    NormalizedVideo[]
> {
    constructor(
        private readonly provider: BaseProvider,
        private readonly client: GoogleGenAI
    ) {}

    /**
     * Creates a Gemini video generation job and optionally waits for a terminal result.
     *
     * @param request Unified generation request containing prompt, optional reference image, and runtime params.
     * @param _executionContext Optional multimodal execution context. Unused directly in this adapter.
     * @param signal Optional abort signal for request, polling, and download cancellation.
     * @returns Normalized video artifacts plus provider metadata.
     */
    async generateVideo(
        request: AIRequest<ClientVideoGenerationRequest>,
        _executionContext?: MultiModalExecutionContext,
        signal?: AbortSignal
    ): Promise<AIResponse<NormalizedVideo[]>> {
        this.provider.ensureInitialized();
        const { input, options, context } = request;

        if (!input?.prompt?.trim()) {
            throw new Error("Prompt is required for Gemini video generation");
        }

        const merged = this.provider.getMergedOptions(CapabilityKeys.VideoGenerationCapabilityKey, {
            model: options?.model ?? input.params?.model ?? DEFAULT_GEMINI_VIDEO_MODEL,
            modelParams: options?.modelParams,
            providerParams: options?.providerParams,
            generalParams: options?.generalParams
        });

        const model = merged.model ?? DEFAULT_GEMINI_VIDEO_MODEL;
        const source: Record<string, unknown> = {
            prompt: input.prompt
        };

        if (input.referenceImage) {
            // Gemini generation accepts a reference image as inline bytes, so
            // normalize URL/base64 input and embed the image payload directly.
            const referenceUrl = resolveReferenceMediaUrl(
                input.referenceImage,
                "image/png",
                "referenceImage must include url or base64"
            );
            const referenceBytes = await resolveImageToBytes(referenceUrl);
            source.image = {
                imageBytes: referenceBytes.toString("base64"),
                mimeType: input.referenceImage.mimeType ?? "image/png"
            };
        }

        const durationSeconds = resolveGeminiDurationSeconds(
            input.params?.seconds,
            GEMINI_VIDEO_MIN_DURATION_SECONDS,
            GEMINI_VIDEO_MAX_DURATION_SECONDS
        );
        const aspectRatio = this.mapSizeToAspectRatio(input.params?.size);

        const operation = await (this.client.models as any).generateVideos({
            model,
            source,
            config: {
                durationSeconds,
                aspectRatio,
                ...(merged.modelParams ?? {}),
                ...(merged.providerParams ?? {})
            }
        });

        const { pollUntilComplete, pollIntervalMs, maxPollMs, includeBase64 } = resolveGeminiVideoExecutionControls({
            pollUntilComplete: input.params?.pollUntilComplete,
            pollIntervalMs: input.params?.pollIntervalMs ?? merged.generalParams?.pollIntervalMs,
            maxPollMs: input.params?.maxPollMs ?? merged.generalParams?.maxPollMs,
            includeBase64: input.params?.includeBase64
        });

        const finalOperation = await resolveGeminiOperationResult({
            client: this.client,
            operation,
            pollUntilComplete,
            pollIntervalMs,
            maxPollMs,
            signal,
            abortMessage: "Gemini video generation polling aborted",
            timeoutMessage: (operationName) => `Timed out waiting for Gemini video operation '${operationName}'`
        });

        throwIfGeminiOperationFailed(finalOperation, "Gemini video generation failed");
        const operationId = resolveGeminiOperationId(finalOperation);
        const generatedVideo = extractGeneratedVideoOrThrow(
            finalOperation,
            "Gemini video generation response did not include a generated video"
        );
        const base64 = includeBase64
            ? await resolveGeminiVideoBase64({
                  client: this.client,
                  video: generatedVideo,
                  signal,
                  fetchFailureLabel: "Failed to fetch generated video from URI"
              })
            : undefined;

        const output: NormalizedVideo[] = [
            buildGeminiVideoArtifact({
                id: operationId,
                video: generatedVideo,
                base64,
                durationSeconds,
                model,
                operationName: finalOperation?.name,
                done: finalOperation?.done,
                requestId: context?.requestId
            })
        ];

        return {
            output,
            multimodalArtifacts: { video: output },
            rawResponse: finalOperation,
            id: operationId,
            metadata: buildGeminiVideoResponseMetadata({
                contextMetadata: context?.metadata,
                model,
                operationName: finalOperation?.name,
                done: finalOperation?.done,
                requestId: context?.requestId
            })
        };
    }
    /**
     * Maps ProviderPlaneAI size strings to Gemini's supported aspect-ratio hints.
     *
     * @param size Requested video size.
     * @returns Gemini aspect ratio when the size maps cleanly; otherwise `undefined`.
     */
    private mapSizeToAspectRatio(size?: string): "16:9" | "9:16" | undefined {
        if (!size) {
            return undefined;
        }
        if (size === "1280x720" || size === "1792x1024") {
            return "16:9";
        }
        if (size === "720x1280" || size === "1024x1792") {
            return "9:16";
        }
        return undefined;
    }
}
