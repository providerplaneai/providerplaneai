/**
 * @module providers/openai/capabilities/OpenAIVideoGenerationCapabilityImpl.ts
 * @description OpenAI video generation capability adapter.
 */
import OpenAI from "openai";
import {
    AIRequest,
    AIResponse,
    BaseProvider,
    CapabilityKeys,
    ClientVideoGenerationRequest,
    MultiModalExecutionContext,
    NormalizedVideo,
    VideoGenerationCapability,
    toOpenAIReferenceImageFile,
    pollOpenAIVideoUntilTerminal,
    buildOpenAIVideoArtifact,
    buildOpenAIVideoResponseMetadata,
    delayWithAbort,
    resolveOpenAIVideoExecutionControls
} from "#root/index.js";

const DEFAULT_OPENAI_VIDEO_MODEL = "sora-2";

/**
 * Adapts OpenAI video generation responses into ProviderPlaneAI's normalized video artifact surface.
 *
 * Uses OpenAI's Videos API for job creation, optional polling, and optional
 * binary download before normalizing the result into `NormalizedVideo[]`.
 *
 * @public
 */
export class OpenAIVideoGenerationCapabilityImpl implements VideoGenerationCapability<
    ClientVideoGenerationRequest,
    NormalizedVideo[]
> {
    /**
     * Creates a new OpenAI video generation capability adapter.
     *
     * @param {BaseProvider} provider Owning provider instance used for initialization checks and merged config access.
     * @param {OpenAI} client Initialized OpenAI SDK client.
     */
    constructor(
        private readonly provider: BaseProvider,
        private readonly client: OpenAI
    ) {}

    /**
     * Executes an OpenAI video generation request.
     *
     * @param {AIRequest<ClientVideoGenerationRequest>} request Unified video generation request envelope.
     * @param {MultiModalExecutionContext} [_executionContext] Optional multimodal execution context. Unused directly in this adapter.
     * @param {AbortSignal} [signal] Optional cancellation signal for request, polling, and download steps.
     * @returns {Promise<AIResponse<NormalizedVideo[]>>} Provider-normalized generated video artifacts.
     * @throws {Error} When the prompt is missing, polling fails, or the provider returns a failed job.
     */
    async generateVideo(
        request: AIRequest<ClientVideoGenerationRequest>,
        _executionContext?: MultiModalExecutionContext,
        signal?: AbortSignal
    ): Promise<AIResponse<NormalizedVideo[]>> {
        this.provider.ensureInitialized();
        const { input, options, context } = request;
        if (!input?.prompt) {
            throw new Error("Prompt is required for video generation");
        }

        const merged = this.provider.getMergedOptions(CapabilityKeys.VideoGenerationCapabilityKey, {
            model: options?.model ?? input.params?.model ?? DEFAULT_OPENAI_VIDEO_MODEL,
            modelParams: options?.modelParams,
            providerParams: options?.providerParams,
            generalParams: options?.generalParams
        });
        const inputReference = await toOpenAIReferenceImageFile(
            input.referenceImage,
            "video-reference.png",
            "OpenAI video input_reference requires uploaded image content; pass referenceImage.base64 (+ mimeType) instead of url",
            "referenceImage must include either base64 data or be omitted"
        );

        const created = await this.client.videos.create(
            {
                prompt: input.prompt,
                model: (merged.model ?? DEFAULT_OPENAI_VIDEO_MODEL) as any,
                seconds: (input.params?.seconds as any) ?? undefined,
                size: (input.params?.size as any) ?? undefined,
                ...(inputReference ? { input_reference: inputReference } : {}),
                ...(merged.modelParams ?? {}),
                ...(merged.providerParams ?? {})
            },
            { signal }
        );

        const { pollUntilComplete, pollIntervalMs, maxPollMs, includeBase64 } = resolveOpenAIVideoExecutionControls({
            pollUntilComplete: input.params?.pollUntilComplete,
            pollIntervalMs: input.params?.pollIntervalMs ?? merged.generalParams?.pollIntervalMs,
            maxPollMs: input.params?.maxPollMs ?? merged.generalParams?.maxPollMs,
            includeBase64: input.params?.includeBase64
        });
        const variant = input.params?.downloadVariant ?? "video";

        const video = pollUntilComplete
            ? await pollOpenAIVideoUntilTerminal({
                  videoId: created.id,
                  pollIntervalMs,
                  maxPollMs,
                  signal,
                  retrieve: (videoId, retrieveOptions) => this.client.videos.retrieve(videoId, retrieveOptions),
                  getStatus: (video) => video.status,
                  delay: (ms, abortSignal) => delayWithAbort(ms, abortSignal, "Video generation polling aborted"),
                  abortMessage: "Video generation polling aborted"
              })
            : created;

        if (video.status === "failed") {
            throw new Error(
                `Video generation failed${video.error?.code ? ` [${video.error.code}]` : ""}: ${
                    video.error?.message ?? "unknown error"
                }`
            );
        }

        let base64: string | undefined;
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
                requestId: context?.requestId
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
                expiresAt: video.expires_at
            })
        };
    }
}
