/**
 * @module providers/openai/capabilities/OpenAIVideoDownloadCapabilityImpl.ts
 * @description OpenAI video download capability adapter.
 */
import OpenAI from "openai";
import {
    AIProvider,
    AIRequest,
    AIResponse,
    BaseProvider,
    CapabilityKeys,
    ClientVideoDownloadRequest,
    MultiModalExecutionContext,
    NormalizedVideo,
    VideoDownloadCapability,
    buildMetadata
} from "#root/index.js";

const DEFAULT_VIDEO_DOWNLOAD_TIMEOUT_MS = 30_000;

/**
 * Adapts OpenAI video download responses into ProviderPlaneAI's normalized video artifact surface.
 *
 * Uses `videos.downloadContent` to fetch the selected variant and returns it as
 * a normalized video or image artifact depending on the variant requested.
 *
 * @public
 */
export class OpenAIVideoDownloadCapabilityImpl implements VideoDownloadCapability<
    ClientVideoDownloadRequest,
    NormalizedVideo[]
> {
    /**
     * Creates a new OpenAI video download capability adapter.
     *
     * @param {BaseProvider} provider Owning provider instance used for initialization checks and merged config access.
     * @param {OpenAI} client Initialized OpenAI SDK client.
     */
    constructor(
        private readonly provider: BaseProvider,
        private readonly client: OpenAI
    ) {}

    /**
     * Downloads a previously generated OpenAI video variant.
     *
     * @param {AIRequest<ClientVideoDownloadRequest>} request Unified video download request envelope.
     * @param {MultiModalExecutionContext} [_executionContext] Optional multimodal execution context. Unused directly in this adapter.
     * @param {AbortSignal} [signal] Optional cancellation signal.
     * @returns {Promise<AIResponse<NormalizedVideo[]>>} Provider-normalized downloaded video artifacts.
     * @throws {Error} When `videoId` is missing.
     */
    async downloadVideo(
        request: AIRequest<ClientVideoDownloadRequest>,
        _executionContext?: MultiModalExecutionContext,
        signal?: AbortSignal
    ): Promise<AIResponse<NormalizedVideo[]>> {
        this.provider.ensureInitialized();
        const { input, options, context } = request;

        const videoId = input?.videoId?.trim();
        if (!videoId) {
            throw new Error("videoId is required for video download");
        }

        const merged = this.provider.getMergedOptions(CapabilityKeys.VideoDownloadCapabilityKey, options);
        const timeoutMs = this.resolveDownloadTimeoutMs(merged?.generalParams?.downloadTimeoutMs);
        const effectiveSignal = this.composeSignalWithTimeout(signal, timeoutMs);

        const variant = input.variant ?? "video";
        const response = await this.client.videos.downloadContent(
            videoId,
            { variant: variant as any },
            {
                signal: effectiveSignal
            }
        );
        const bytes = Buffer.from(await response.arrayBuffer());
        const base64 = bytes.length > 0 ? bytes.toString("base64") : undefined;
        const artifactId = `${videoId}:${variant}`;

        const output: NormalizedVideo[] = [
            {
                id: artifactId,
                mimeType: this.resolveMimeTypeForVariant(variant),
                base64,
                metadata: buildMetadata(undefined, {
                    provider: AIProvider.OpenAI,
                    sourceVideoId: videoId,
                    variant,
                    requestId: context?.requestId
                })
            }
        ];

        return {
            output,
            multimodalArtifacts: { video: output },
            rawResponse: {
                videoId,
                variant,
                bytes: bytes.length
            },
            id: artifactId,
            metadata: buildMetadata(context?.metadata, {
                provider: AIProvider.OpenAI,
                sourceVideoId: videoId,
                variant,
                downloadTimeoutMs: timeoutMs,
                bytes: bytes.length,
                requestId: context?.requestId
            })
        };
    }

    private resolveMimeTypeForVariant(variant: string): string {
        if (variant === "thumbnail" || variant === "spritesheet") {
            return "image/jpeg";
        }
        return "video/mp4";
    }

    private resolveDownloadTimeoutMs(value: unknown): number {
        const parsed = Number(value);
        if (!Number.isFinite(parsed) || parsed <= 0) {
            return DEFAULT_VIDEO_DOWNLOAD_TIMEOUT_MS;
        }
        return Math.floor(parsed);
    }

    private composeSignalWithTimeout(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
        const timeoutSignal = AbortSignal.timeout(timeoutMs);
        if (!signal) {
            return timeoutSignal;
        }
        if (signal.aborted) {
            return signal;
        }
        const abortController = new AbortController();
        const abort = () => abortController.abort();
        signal.addEventListener("abort", abort, { once: true });
        timeoutSignal.addEventListener("abort", abort, { once: true });
        return abortController.signal;
    }
}
