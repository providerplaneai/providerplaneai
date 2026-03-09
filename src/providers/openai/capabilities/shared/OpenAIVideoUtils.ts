/**
 * @module providers/openai/capabilities/shared/OpenAIVideoUtils.ts
 * @description Shared helper utilities for provider video capabilities.
 */
import type OpenAI from "openai";
import { AIProvider, NormalizedVideo } from "#root/index.js";

const MIN_VIDEO_POLL_INTERVAL_MS = 250;

/**
 * @public
 * @description Helper type for OpenAIVideoVariant.
 */
export type OpenAIVideoVariant = "video" | "thumbnail" | "spritesheet" | string;

/**
 * @public
 * @description Helper type for OpenAIVideoPollingOptions.
 */
export type OpenAIVideoPollingOptions = {
    pollIntervalMs?: number;
    maxPollMs?: number;
    defaultPollIntervalMs: number;
    defaultMaxPollMs: number;
};

type PollOpenAIVideoArgs<TVideo> = {
    videoId: string;
    pollIntervalMs: number;
    maxPollMs: number;
    signal?: AbortSignal;
    retrieve: (videoId: string, options: { signal?: AbortSignal }) => Promise<TVideo>;
    getStatus: (video: TVideo) => string | undefined;
    delay?: (ms: number, signal?: AbortSignal) => Promise<void>;
    abortMessage: string;
};

type OpenAIVideoStatusPayload = {
    status?: string;
    error?: { code?: string; message?: string } | null;
};

type BuildOpenAIVideoArtifactArgs = {
    id: string;
    variant: OpenAIVideoVariant;
    base64?: string;
    durationSeconds: number;
    size: string;
    raw: unknown;
    model: string | undefined;
    status: string | undefined;
    requestId: string | undefined;
    extraMetadata?: Record<string, unknown>;
};

type BuildOpenAIVideoResponseMetadataArgs = {
    contextMetadata?: Record<string, unknown>;
    model: string | undefined;
    status: string | undefined;
    requestId: string | undefined;
    progress: unknown;
    createdAt: unknown;
    completedAt: unknown;
    expiresAt: unknown;
    extraMetadata?: Record<string, unknown>;
};

/**
 * Normalizes poll interval limits so polling behavior is predictable across capabilities.
 */
/**
 * @public
 * @description Helper utility for resolvePollingWindow.
 * @param options Polling configuration input.
 * @returns Normalized helper result.
 */
export function resolvePollingWindow(options: OpenAIVideoPollingOptions): {
    pollIntervalMs: number;
    maxPollMs: number;
} {
    const pollIntervalMs = Math.max(
        MIN_VIDEO_POLL_INTERVAL_MS,
        Number(options.pollIntervalMs ?? options.defaultPollIntervalMs)
    );
    const maxPollMs = Math.max(pollIntervalMs, Number(options.maxPollMs ?? options.defaultMaxPollMs));
    return { pollIntervalMs, maxPollMs };
}

/**
 * Converts OpenAI video size strings (for example: "1280x720") to numeric dimensions.
 */
/**
 * @public
 * @description Helper utility for parseVideoSize.
 * @param size Raw provider size value.
 * @returns Normalized helper result.
 */
export function parseVideoSize(size: string): { width?: number; height?: number } {
    const [w, h] = size.split("x", 2);
    const width = Number.parseInt(w, 10);
    const height = Number.parseInt(h, 10);
    return {
        width: Number.isFinite(width) ? width : undefined,
        height: Number.isFinite(height) ? height : undefined
    };
}

/**
 * Maps download variant to mime type for normalized artifacts.
 */
/**
 * @public
 * @description Helper utility for resolveVariantMimeType.
 * @param variant Requested provider download variant.
 * @returns Normalized helper result.
 */
export function resolveVariantMimeType(variant: OpenAIVideoVariant): string {
    if (variant === "thumbnail" || variant === "spritesheet") {
        return "image/jpeg";
    }
    return "video/mp4";
}

/**
 * Sleeps for the requested poll interval and exits early if the request is aborted.
 */
/**
 * @public
 * @description Helper utility for delayWithAbort.
 * @param ms Delay duration in milliseconds.
 * @param signal Optional abort signal.
 * @param abortMessage Error message used when aborted.
 * @returns Normalized helper result.
 */
export function delayWithAbort(ms: number, signal: AbortSignal | undefined, abortMessage: string): Promise<void> {
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
            reject(new Error(abortMessage));
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

/**
 * Polls OpenAI videos until the operation reaches a terminal state.
 */
export async function pollOpenAIVideoUntilTerminal<TVideo>(args: PollOpenAIVideoArgs<TVideo>): Promise<TVideo> {
    const started = Date.now();
    while (true) {
        if (args.signal?.aborted) {
            throw new Error(args.abortMessage);
        }

        const video = await args.retrieve(args.videoId, { signal: args.signal });
        const status = args.getStatus(video);
        if (status === "completed" || status === "failed") {
            return video;
        }

        if (Date.now() - started >= args.maxPollMs) {
            throw new Error(`Timed out waiting for video job '${args.videoId}' to complete`);
        }

        if (args.delay) {
            await args.delay(args.pollIntervalMs, args.signal);
        } else {
            await delayWithAbort(args.pollIntervalMs, args.signal, args.abortMessage);
        }
    }
}

/**
 * Downloads OpenAI video variant content and returns base64 payload.
 */
export async function downloadVariantBase64(
    client: OpenAI,
    videoId: string,
    variant: OpenAIVideoVariant,
    signal?: AbortSignal
): Promise<string | undefined> {
    const contentResponse = await client.videos.downloadContent(videoId, { variant: variant as any }, { signal });
    const bytes = Buffer.from(await contentResponse.arrayBuffer());
    return bytes.length > 0 ? bytes.toString("base64") : undefined;
}

/**
 * Throws normalized failure message when OpenAI video operation is in failed state.
 */
/**
 * @public
 * @description Helper utility for throwIfFailedVideoStatus.
 * @param video Provider video payload to validate.
 * @param operationName Operation label for error context.
 * @returns Normalized helper result.
 */
export function throwIfFailedVideoStatus(video: OpenAIVideoStatusPayload, operationName: "generation" | "remix"): void {
    if (video.status !== "failed") {
        return;
    }

    throw new Error(
        `Video ${operationName} failed${video.error?.code ? ` [${video.error.code}]` : ""}: ${
            video.error?.message ?? "unknown error"
        }`
    );
}

/**
 * Creates a normalized OpenAI video artifact with shared metadata.
 */
/**
 * @public
 * @description Helper utility for buildOpenAIVideoArtifact.
 * @param args Structured helper arguments.
 * @returns Normalized helper result.
 */
export function buildOpenAIVideoArtifact(args: BuildOpenAIVideoArtifactArgs): NormalizedVideo {
    return {
        id: args.id,
        mimeType: resolveVariantMimeType(args.variant),
        base64: args.base64,
        durationSeconds: args.durationSeconds,
        ...parseVideoSize(args.size),
        raw: args.raw,
        metadata: {
            provider: AIProvider.OpenAI,
            model: args.model,
            status: args.status,
            requestId: args.requestId,
            ...(args.extraMetadata ?? {})
        }
    };
}

/**
 * Builds top-level response metadata for OpenAI video capabilities.
 */
/**
 * @public
 * @description Helper utility for buildOpenAIVideoResponseMetadata.
 * @param args Structured helper arguments.
 * @returns Normalized helper result.
 */
export function buildOpenAIVideoResponseMetadata(args: BuildOpenAIVideoResponseMetadataArgs): Record<string, unknown> {
    return {
        ...(args.contextMetadata ?? {}),
        provider: AIProvider.OpenAI,
        model: args.model,
        status: args.status,
        requestId: args.requestId,
        progress: args.progress,
        createdAt: args.createdAt,
        completedAt: args.completedAt,
        expiresAt: args.expiresAt,
        ...(args.extraMetadata ?? {})
    };
}
