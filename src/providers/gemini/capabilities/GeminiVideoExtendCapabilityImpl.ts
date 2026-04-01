/**
 * @module providers/gemini/capabilities/GeminiVideoExtendCapabilityImpl.ts
 * @description Gemini video extend capability adapter.
 */
import { GoogleGenAI } from "@google/genai";
import {
    AIRequest,
    AIResponse,
    BaseProvider,
    CapabilityKeys,
    ClientVideoExtendRequest,
    MultiModalExecutionContext,
    NormalizedVideo,
    VideoExtendCapability
} from "#root/index.js";
import {
    buildGeminiVideoArtifact,
    buildGeminiVideoResponseMetadata,
    extractGeneratedVideoOrThrow,
    readFiniteNumber,
    resolveGeminiDurationSeconds,
    resolveGeminiOperationId,
    resolveGeminiOperationResult,
    resolveGeminiVideoBase64,
    resolveGeminiVideoExecutionControls,
    throwIfGeminiOperationFailed
} from "#root/providers/gemini/capabilities/shared/GeminiVideoUtils.js";
const GEMINI_VIDEO_MIN_DURATION_SECONDS = 4;
const GEMINI_VIDEO_MAX_DURATION_SECONDS = 8;

/**
 * Gemini video extension capability implementation.
 *
 * Uses Gemini's long-running video generation API with a source video payload,
 * optionally polls until completion, and normalizes the extended video into
 * `NormalizedVideo[]`.
 *
 * @public
 */
export class GeminiVideoExtendCapabilityImpl implements VideoExtendCapability<ClientVideoExtendRequest, NormalizedVideo[]> {
    constructor(
        private readonly provider: BaseProvider,
        private readonly client: GoogleGenAI
    ) {}

    /**
     * Creates a Gemini video extension job from an existing source video.
     *
     * @param request Unified extension request containing the source video and optional prompt/config overrides.
     * @param _executionContext Optional multimodal execution context. Unused directly in this adapter.
     * @param signal Optional abort signal for request, polling, and download cancellation.
     * @returns Normalized video artifacts plus provider metadata.
     */
    async extendVideo(
        request: AIRequest<ClientVideoExtendRequest>,
        _executionContext?: MultiModalExecutionContext,
        signal?: AbortSignal
    ): Promise<AIResponse<NormalizedVideo[]>> {
        this.provider.ensureInitialized();
        const { input, options, context } = request;

        if (!input?.sourceVideoUri && !input?.sourceVideoBase64) {
            throw new Error("sourceVideoUri or sourceVideoBase64 is required for Gemini video extension");
        }

        const merged = this.provider.getMergedOptions(CapabilityKeys.VideoExtendCapabilityKey, {
            model: options?.model ?? input.params?.model,
            modelParams: options?.modelParams,
            providerParams: options?.providerParams,
            generalParams: options?.generalParams
        });

        const durationSeconds = resolveGeminiDurationSeconds(
            input.params?.durationSeconds ??
                readFiniteNumber((merged.modelParams as Record<string, unknown> | undefined)?.durationSeconds) ??
                readFiniteNumber((merged.providerParams as Record<string, unknown> | undefined)?.durationSeconds),
            GEMINI_VIDEO_MIN_DURATION_SECONDS,
            GEMINI_VIDEO_MAX_DURATION_SECONDS
        );
        const config: Record<string, unknown> = {
            ...(merged.modelParams ?? {}),
            ...(merged.providerParams ?? {}),
            ...(input.params?.aspectRatio ? { aspectRatio: input.params.aspectRatio } : {}),
            ...(input.params?.resolution ? { resolution: input.params.resolution } : {})
        };
        if (durationSeconds !== undefined) {
            config.durationSeconds = durationSeconds;
        }

        const operation = await (this.client.models as any).generateVideos({
            model: merged.model,
            source: {
                // Gemini extension reuses the same endpoint as generation, but
                // passes the original video in the `source.video` payload.
                ...(input.prompt ? { prompt: input.prompt } : {}),
                video: {
                    ...(input.sourceVideoUri ? { uri: input.sourceVideoUri } : {}),
                    ...(input.sourceVideoBase64 ? { videoBytes: input.sourceVideoBase64 } : {}),
                    ...(input.sourceVideoMimeType ? { mimeType: input.sourceVideoMimeType } : {})
                }
            },
            config
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
            abortMessage: "Gemini video extension polling aborted",
            timeoutMessage: (operationName) => `Timed out waiting for Gemini video operation '${operationName}'`
        });

        throwIfGeminiOperationFailed(
            finalOperation,
            `Gemini video extension failed (model=${String(merged.model)}, durationSeconds=${durationSeconds ?? "unset"})`
        );
        const operationId = resolveGeminiOperationId(finalOperation);
        const generatedVideo = extractGeneratedVideoOrThrow(
            finalOperation,
            "Gemini video extension response did not include a generated video"
        );
        const base64 = includeBase64
            ? await resolveGeminiVideoBase64({
                  client: this.client,
                  video: generatedVideo,
                  signal,
                  fetchFailureLabel: "Failed to fetch extended video from URI"
              })
            : undefined;

        const output: NormalizedVideo[] = [
            buildGeminiVideoArtifact({
                id: operationId,
                video: generatedVideo,
                base64,
                durationSeconds,
                model: merged.model,
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
                model: merged.model,
                operationName: finalOperation?.name,
                done: finalOperation?.done,
                requestId: context?.requestId
            })
        };
    }
}
