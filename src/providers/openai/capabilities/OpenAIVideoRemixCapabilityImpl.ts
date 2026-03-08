import OpenAI from "openai";
import {
    AIProvider,
    AIRequest,
    AIResponse,
    BaseProvider,
    ClientVideoRemixRequest,
    MultiModalExecutionContext,
    NormalizedVideo,
    VideoRemixCapability
} from "#root/index.js";

const DEFAULT_VIDEO_POLL_INTERVAL_MS = 2_000;
const DEFAULT_VIDEO_MAX_POLL_MS = 300_000;

/**
 * OpenAI video remix capability implementation.
 *
 * Uses OpenAI Videos API (`videos.remix`, `videos.retrieve`, `videos.downloadContent`)
 * and normalizes job output into `NormalizedVideo[]`.
 */
export class OpenAIVideoRemixCapabilityImpl implements VideoRemixCapability<ClientVideoRemixRequest, NormalizedVideo[]> {
    constructor(
        private readonly provider: BaseProvider,
        private readonly client: OpenAI
    ) {}

    async remixVideo(
        request: AIRequest<ClientVideoRemixRequest>,
        _executionContext?: MultiModalExecutionContext,
        signal?: AbortSignal
    ): Promise<AIResponse<NormalizedVideo[]>> {
        this.provider.ensureInitialized();
        const { input, context } = request;

        if (!input?.sourceVideoId?.trim()) {
            throw new Error("sourceVideoId is required for video remix");
        }
        if (!input?.prompt) {
            throw new Error("Prompt is required for video remix");
        }

        const created = await this.client.videos.remix(input.sourceVideoId.trim(), { prompt: input.prompt }, { signal });

        const pollUntilComplete = input.params?.pollUntilComplete ?? true;
        const pollIntervalMs = Math.max(250, Number(input.params?.pollIntervalMs ?? DEFAULT_VIDEO_POLL_INTERVAL_MS));
        const maxPollMs = Math.max(pollIntervalMs, Number(input.params?.maxPollMs ?? DEFAULT_VIDEO_MAX_POLL_MS));
        const includeBase64 = input.params?.includeBase64 ?? false;
        const variant = input.params?.downloadVariant ?? "video";

        const video = pollUntilComplete ? await this.pollUntilTerminal(created.id, pollIntervalMs, maxPollMs, signal) : created;

        if (video.status === "failed") {
            throw new Error(
                `Video remix failed${video.error?.code ? ` [${video.error.code}]` : ""}: ${
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
            {
                id: video.id,
                mimeType: this.resolveMimeTypeForVariant(variant),
                base64,
                durationSeconds: Number(video.seconds),
                ...this.parseVideoSize(video.size),
                raw: video,
                metadata: {
                    provider: AIProvider.OpenAI,
                    model: video.model,
                    status: video.status,
                    remixedFromVideoId: video.remixed_from_video_id,
                    requestId: context?.requestId
                }
            }
        ];

        return {
            output,
            multimodalArtifacts: { video: output },
            rawResponse: video,
            id: video.id,
            metadata: {
                ...(context?.metadata ?? {}),
                provider: AIProvider.OpenAI,
                model: video.model,
                status: video.status,
                remixedFromVideoId: video.remixed_from_video_id,
                requestId: context?.requestId,
                progress: video.progress,
                createdAt: video.created_at,
                completedAt: video.completed_at,
                expiresAt: video.expires_at
            }
        };
    }

    private async pollUntilTerminal(videoId: string, pollIntervalMs: number, maxPollMs: number, signal?: AbortSignal) {
        const started = Date.now();
        while (true) {
            if (signal?.aborted) {
                throw new Error("Video remix polling aborted");
            }

            const video = await this.client.videos.retrieve(videoId, { signal });
            if (video.status === "completed" || video.status === "failed") {
                return video;
            }

            if (Date.now() - started >= maxPollMs) {
                throw new Error(`Timed out waiting for video job '${videoId}' to complete`);
            }

            await this.delay(pollIntervalMs, signal);
        }
    }

    private delay(ms: number, signal?: AbortSignal): Promise<void> {
        if (ms <= 0) {
            return Promise.resolve();
        }

        return new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => {
                signal?.removeEventListener("abort", onAbort);
                resolve();
            }, ms);
            const onAbort = () => {
                clearTimeout(timer);
                reject(new Error("Video remix polling aborted"));
            };
            if (signal) {
                if (signal.aborted) {
                    onAbort();
                    return;
                }
                signal.addEventListener("abort", onAbort, { once: true });
            }
        });
    }

    private parseVideoSize(size: string): { width?: number; height?: number } {
        const [w, h] = size.split("x", 2);
        const width = Number.parseInt(w, 10);
        const height = Number.parseInt(h, 10);
        return {
            width: Number.isFinite(width) ? width : undefined,
            height: Number.isFinite(height) ? height : undefined
        };
    }

    private resolveMimeTypeForVariant(variant: string): string {
        if (variant === "thumbnail") {
            return "image/jpeg";
        }
        if (variant === "spritesheet") {
            return "image/jpeg";
        }
        return "video/mp4";
    }
}
