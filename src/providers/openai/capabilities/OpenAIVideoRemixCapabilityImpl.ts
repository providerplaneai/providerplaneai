/**
 * @module providers/openai/capabilities/OpenAIVideoRemixCapabilityImpl.ts
 * @description OpenAI video remix capability adapter.
 */
import OpenAI from "openai";
import {
    AIRequest,
    AIResponse,
    BaseProvider,
    CapabilityKeys,
    ClientVideoRemixRequest,
    MultiModalExecutionContext,
    NormalizedVideo,
    VideoRemixCapability,
    delayWithAbort,
    pollOpenAIVideoUntilTerminal,
    buildOpenAIVideoArtifact,
    buildOpenAIVideoResponseMetadata,
    resolveOpenAIVideoExecutionControls
} from "#root/index.js";

/**
 * Adapts OpenAI video remix responses into ProviderPlaneAI's normalized video artifact surface.
 *
 * Uses OpenAI's Videos API for remix job creation, optional polling, and optional
 * binary download before normalizing the result into `NormalizedVideo[]`.
 *
 * @public
 */
export class OpenAIVideoRemixCapabilityImpl implements VideoRemixCapability<ClientVideoRemixRequest, NormalizedVideo[]> {
    /**
     * Creates a new OpenAI video remix capability adapter.
     *
     * @param {BaseProvider} provider Owning provider instance used for initialization checks and merged config access.
     * @param {OpenAI} client Initialized OpenAI SDK client.
     */
    constructor(
        private readonly provider: BaseProvider,
        private readonly client: OpenAI
    ) {}

    /**
     * Creates a remixed video from an existing OpenAI video id.
     *
     * @param {AIRequest<ClientVideoRemixRequest>} request Unified video remix request envelope.
     * @param {MultiModalExecutionContext} [_executionContext] Optional multimodal execution context. Unused directly in this adapter.
     * @param {AbortSignal} [signal] Optional cancellation signal for remix, polling, and download steps.
     * @returns {Promise<AIResponse<NormalizedVideo[]>>} Provider-normalized remixed video artifacts.
     * @throws {Error} When required input is missing, polling times out, operation is aborted, or the provider returns failed status.
     */
    async remixVideo(
        request: AIRequest<ClientVideoRemixRequest>,
        _executionContext?: MultiModalExecutionContext,
        signal?: AbortSignal
    ): Promise<AIResponse<NormalizedVideo[]>> {
        this.provider.ensureInitialized();
        const { input, options, context } = request;

        if (!input?.sourceVideoId?.trim()) {
            throw new Error("sourceVideoId is required for video remix");
        }
        if (!input?.prompt) {
            throw new Error("Prompt is required for video remix");
        }

        const merged = this.provider.getMergedOptions(CapabilityKeys.VideoRemixCapabilityKey, {
            model: options?.model,
            modelParams: options?.modelParams,
            providerParams: options?.providerParams,
            generalParams: options?.generalParams
        });

        // OpenAI remix endpoint currently accepts prompt + source video id only.
        const created = await this.client.videos.remix(input.sourceVideoId.trim(), { prompt: input.prompt }, { signal });

        const { pollUntilComplete, pollIntervalMs, maxPollMs, includeBase64 } = resolveOpenAIVideoExecutionControls({
            pollUntilComplete: input.params?.pollUntilComplete,
            pollIntervalMs: input.params?.pollIntervalMs ?? merged.generalParams?.pollIntervalMs,
            maxPollMs: input.params?.maxPollMs ?? merged.generalParams?.maxPollMs,
            includeBase64: input.params?.includeBase64
        });
        const variant = input.params?.downloadVariant ?? "video";

        // For non-poll flows, return the initial operation payload directly.
        const video = pollUntilComplete
            ? await pollOpenAIVideoUntilTerminal({
                  videoId: created.id,
                  pollIntervalMs,
                  maxPollMs,
                  signal,
                  retrieve: (videoId, retrieveOptions) => this.client.videos.retrieve(videoId, retrieveOptions),
                  getStatus: (video) => video.status,
                  delay: (ms, abortSignal) => delayWithAbort(ms, abortSignal, "Video remix polling aborted"),
                  abortMessage: "Video remix polling aborted"
              })
            : created;

        if (video.status === "failed") {
            throw new Error(
                `Video remix failed${video.error?.code ? ` [${video.error.code}]` : ""}: ${
                    video.error?.message ?? "unknown error"
                }`
            );
        }

        let base64: string | undefined;
        // Only completed jobs can be downloaded.
        if (includeBase64 && video.status === "completed") {
            const contentResponse = await this.client.videos.downloadContent(video.id, { variant: variant as any }, { signal });
            const bytes = Buffer.from(await contentResponse.arrayBuffer());
            base64 = bytes.length > 0 ? bytes.toString("base64") : undefined;
        }

        const output: NormalizedVideo[] = [
            buildOpenAIVideoArtifact({
                id: video.id,
                variant,
                base64,
                durationSeconds: Number(video.seconds),
                size: video.size,
                raw: video,
                model: video.model,
                status: video.status,
                requestId: context?.requestId,
                extraMetadata: { remixedFromVideoId: video.remixed_from_video_id }
            })
        ];

        return {
            output,
            multimodalArtifacts: { video: output },
            rawResponse: video,
            id: video.id,
            metadata: buildOpenAIVideoResponseMetadata({
                contextMetadata: context?.metadata,
                model: video.model,
                status: video.status,
                requestId: context?.requestId,
                progress: video.progress,
                createdAt: video.created_at,
                completedAt: video.completed_at,
                expiresAt: video.expires_at,
                extraMetadata: { remixedFromVideoId: video.remixed_from_video_id }
            })
        };
    }
}
