import OpenAI from "openai";
import {
    AIProvider,
    AIRequest,
    AIResponse,
    BaseProvider,
    CapabilityKeys,
    ClientReferenceImage,
    ClientVideoGenerationRequest,
    MultiModalExecutionContext,
    NormalizedVideo,
    VideoGenerationCapability
} from "#root/index.js";
import { toFile } from "openai/uploads";

const DEFAULT_OPENAI_VIDEO_MODEL = "sora-2";
const DEFAULT_VIDEO_POLL_INTERVAL_MS = 2_000;
const DEFAULT_VIDEO_MAX_POLL_MS = 300_000;

/**
 * OpenAI video generation capability implementation.
 *
 * Uses OpenAI Videos API (`videos.create`, `videos.retrieve`, `videos.downloadContent`)
 * and normalizes job output into `NormalizedVideo[]`.
 */
export class OpenAIVideoGenerationCapabilityImpl implements VideoGenerationCapability<
    ClientVideoGenerationRequest,
    NormalizedVideo[]
> {
    constructor(
        private readonly provider: BaseProvider,
        private readonly client: OpenAI
    ) {}

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
        const inputReference = await this.buildInputReference(input.referenceImage);

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

        const pollUntilComplete = input.params?.pollUntilComplete ?? true;
        const pollIntervalMs = Math.max(
            250,
            Number(input.params?.pollIntervalMs ?? merged.generalParams?.pollIntervalMs ?? DEFAULT_VIDEO_POLL_INTERVAL_MS)
        );
        const maxPollMs = Math.max(
            pollIntervalMs,
            Number(input.params?.maxPollMs ?? merged.generalParams?.maxPollMs ?? DEFAULT_VIDEO_MAX_POLL_MS)
        );
        const includeBase64 = input.params?.includeBase64 ?? false;
        const variant = input.params?.downloadVariant ?? "video";

        const video = pollUntilComplete ? await this.pollUntilTerminal(created.id, pollIntervalMs, maxPollMs, signal) : created;

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
                throw new Error("Video generation polling aborted");
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
                reject(new Error("Video generation polling aborted"));
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

    private async buildInputReference(referenceImage?: ClientReferenceImage) {
        if (!referenceImage) {
            return undefined;
        }

        if (referenceImage.base64) {
            const mimeType = referenceImage.mimeType ?? "image/png";
            const bytes = Buffer.from(referenceImage.base64, "base64");
            const extension = mimeType.split("/", 2)[1] ?? "png";
            return await toFile(bytes, `video-reference.${extension}`, { type: mimeType });
        }

        if (referenceImage.url) {
            throw new Error(
                "OpenAI video input_reference requires uploaded image content; pass referenceImage.base64 (+ mimeType) instead of url"
            );
        }

        throw new Error("referenceImage must include either base64 data or be omitted");
    }
}
