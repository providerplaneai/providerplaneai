import OpenAI from "openai";
import {
    AIProvider,
    AIRequest,
    AIResponse,
    BaseProvider,
    ClientVideoDownloadRequest,
    MultiModalExecutionContext,
    NormalizedVideo,
    VideoDownloadCapability
} from "#root/index.js";

/**
 * OpenAI video download capability implementation.
 *
 * Uses OpenAI Videos API `videos.downloadContent` to fetch the selected asset
 * and returns it as a normalized video artifact.
 */
export class OpenAIVideoDownloadCapabilityImpl implements VideoDownloadCapability<
    ClientVideoDownloadRequest,
    NormalizedVideo[]
> {
    constructor(
        private readonly provider: BaseProvider,
        private readonly client: OpenAI
    ) {}

    async downloadVideo(
        request: AIRequest<ClientVideoDownloadRequest>,
        _executionContext?: MultiModalExecutionContext,
        signal?: AbortSignal
    ): Promise<AIResponse<NormalizedVideo[]>> {
        this.provider.ensureInitialized();
        const { input, context } = request;

        const videoId = input?.videoId?.trim();
        if (!videoId) {
            throw new Error("videoId is required for video download");
        }

        const variant = input.variant ?? "video";
        const response = await this.client.videos.downloadContent(videoId, { variant: variant as any }, { signal });
        const bytes = Buffer.from(await response.arrayBuffer());
        const base64 = bytes.length > 0 ? bytes.toString("base64") : undefined;
        const artifactId = `${videoId}:${variant}`;

        const output: NormalizedVideo[] = [
            {
                id: artifactId,
                mimeType: this.resolveMimeTypeForVariant(variant),
                base64,
                metadata: {
                    provider: AIProvider.OpenAI,
                    sourceVideoId: videoId,
                    variant,
                    requestId: context?.requestId
                }
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
            metadata: {
                ...(context?.metadata ?? {}),
                provider: AIProvider.OpenAI,
                sourceVideoId: videoId,
                variant,
                bytes: bytes.length,
                requestId: context?.requestId
            }
        };
    }

    private resolveMimeTypeForVariant(variant: string): string {
        if (variant === "thumbnail" || variant === "spritesheet") {
            return "image/jpeg";
        }
        return "video/mp4";
    }
}
