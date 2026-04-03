/**
 * @module providers/openai/capabilities/shared/OpenAIVideoUtils.ts
 * @description Shared OpenAI video polling, normalization, and artifact-building helpers.
 */
import type OpenAI from "openai";
import {
    AIProvider,
    NormalizedVideo,
    buildMetadata,
    delayWithAbort as sharedDelayWithAbort,
    resolvePollingWindow as resolveSharedPollingWindow,
    getMaxRawVideoBytes,
    streamBoundedResponse
} from "#root/index.js";

const MIN_VIDEO_POLL_INTERVAL_MS = 250;

/**
 * @public
 * OpenAI video variant identifier.
 */
export type OpenAIVideoVariant = "video" | "thumbnail" | "spritesheet" | string;

/**
 * @public
 * Polling configuration input for OpenAI video operations.
 */
export type OpenAIVideoPollingOptions = {
    pollIntervalMs?: number;
    maxPollMs?: number;
    defaultPollIntervalMs: number;
    defaultMaxPollMs: number;
};

/**
 * @public
 * Runtime execution-control overrides for OpenAI video capabilities.
 */
export type OpenAIVideoExecutionControlsInput = {
    pollUntilComplete?: boolean;
    pollIntervalMs?: number;
    maxPollMs?: number;
    includeBase64?: boolean;
};

export type PollOpenAIVideoArgs<TVideo> = {
    videoId: string;
    pollIntervalMs: number;
    maxPollMs: number;
    signal?: AbortSignal;
    retrieve: (videoId: string, options: { signal?: AbortSignal }) => Promise<TVideo>;
    getStatus: (video: TVideo) => string | undefined;
    delay?: (ms: number, signal?: AbortSignal) => Promise<void>;
    abortMessage: string;
};

export type OpenAIVideoStatusPayload = {
    status?: string;
    error?: { code?: string; message?: string } | null;
};

export type BuildOpenAIVideoArtifactArgs = {
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

export type BuildOpenAIVideoResponseMetadataArgs = {
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
 *
 * @param {OpenAIVideoPollingOptions} options - Polling configuration input.
 * @returns {{ pollIntervalMs: number; maxPollMs: number }} Normalized polling window.
 */
export function resolveOpenAIVideoPollingWindow(options: OpenAIVideoPollingOptions): {
    pollIntervalMs: number;
    maxPollMs: number;
} {
    return resolveSharedPollingWindow({
        ...options,
        minPollIntervalMs: MIN_VIDEO_POLL_INTERVAL_MS
    });
}

/**
 * Resolves runtime polling and payload controls used across OpenAI video capabilities.
 *
 * @param {OpenAIVideoExecutionControlsInput | undefined} input - Execution control overrides.
 * @returns {{ pollUntilComplete: boolean; includeBase64: boolean; pollIntervalMs: number; maxPollMs: number }} Normalized execution controls.
 */
export function resolveOpenAIVideoExecutionControls(input?: OpenAIVideoExecutionControlsInput): {
    pollUntilComplete: boolean;
    includeBase64: boolean;
    pollIntervalMs: number;
    maxPollMs: number;
} {
    const { pollIntervalMs, maxPollMs } = resolveOpenAIVideoPollingWindow({
        pollIntervalMs: input?.pollIntervalMs,
        maxPollMs: input?.maxPollMs,
        defaultPollIntervalMs: 2_000,
        defaultMaxPollMs: 300_000
    });

    return {
        pollUntilComplete: input?.pollUntilComplete ?? true,
        includeBase64: input?.includeBase64 ?? false,
        pollIntervalMs,
        maxPollMs
    };
}

/**
 * Converts OpenAI video size strings (for example: `"1280x720"`) to numeric dimensions.
 *
 * @param {string} size - Raw provider size value.
 * @returns {{ width?: number; height?: number }} Parsed width and height values.
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
 * Maps an OpenAI download variant to a normalized MIME type.
 *
 * @param {OpenAIVideoVariant} variant - Requested provider download variant.
 * @returns {string} MIME type for the normalized artifact.
 */
export function resolveVariantMimeType(variant: OpenAIVideoVariant): string {
    if (variant === "thumbnail" || variant === "spritesheet") {
        return "image/jpeg";
    }
    return "video/mp4";
}

/**
 * Polls OpenAI videos until the operation reaches a terminal state.
 *
 * @template TVideo - Provider video payload type.
 * @param {PollOpenAIVideoArgs<TVideo>} args - Structured polling arguments.
 * @returns {Promise<TVideo>} Final terminal video payload.
 * @throws {Error} When polling is aborted or exceeds the configured timeout.
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
            await sharedDelayWithAbort(args.pollIntervalMs, args.signal, args.abortMessage);
        }
    }
}

/**
 * Downloads OpenAI video variant content and returns base64 payload.
 *
 * @param {OpenAI} client - OpenAI SDK client.
 * @param {string} videoId - Provider video identifier.
 * @param {OpenAIVideoVariant} variant - Variant to download.
 * @param {AbortSignal | undefined} signal - Optional abort signal.
 * @returns {Promise<string | undefined>} Base64 payload when content is available.
 */
export async function downloadVariantBase64(
    client: OpenAI,
    videoId: string,
    variant: OpenAIVideoVariant,
    signal?: AbortSignal
): Promise<string | undefined> {
    const contentResponse = await client.videos.downloadContent(videoId, { variant: variant as any }, { signal });
    const maxBytes = getMaxRawVideoBytes();
    const bytes = await streamBoundedResponse(
        contentResponse,
        maxBytes,
        `Video download exceeds max allowed size (${maxBytes} bytes)`
    );
    return bytes.length > 0 ? bytes.toString("base64") : undefined;
}

/**
 * Throws a normalized failure message when an OpenAI video operation is in the failed state.
 *
 * @param {OpenAIVideoStatusPayload} video - Provider video payload to validate.
 * @param {"generation" | "remix"} operationName - Operation label for error context.
 * @throws {Error} When the provider reports a failed video operation.
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
 *
 * @param {BuildOpenAIVideoArtifactArgs} args - Structured helper arguments.
 * @returns {NormalizedVideo} Normalized video artifact.
 */
export function buildOpenAIVideoArtifact(args: BuildOpenAIVideoArtifactArgs): NormalizedVideo {
    return {
        id: args.id,
        mimeType: resolveVariantMimeType(args.variant),
        base64: args.base64,
        durationSeconds: args.durationSeconds,
        ...parseVideoSize(args.size),
        raw: args.raw,
        metadata: buildMetadata(undefined, {
            provider: AIProvider.OpenAI,
            model: args.model,
            status: args.status,
            requestId: args.requestId,
            ...(args.extraMetadata ?? {})
        })
    };
}

/**
 * Builds top-level response metadata for OpenAI video capabilities.
 *
 * @param {BuildOpenAIVideoResponseMetadataArgs} args - Structured helper arguments.
 * @returns {Record<string, unknown>} Top-level response metadata object.
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
