/**
 * @module providers/gemini/capabilities/shared/GeminiVideoUtils.ts
 * @description Shared helper utilities for provider video capabilities.
 */
import { readFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { GoogleGenAI } from "@google/genai";
import { AIProvider, NormalizedVideo, assertSafeRemoteHttpUrl } from "#root/index.js";

const MIN_VIDEO_POLL_INTERVAL_MS = 250;
const VALID_GEMINI_FILE_NAME = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

/**
 * @public
 * @description Configuration constant for DEFAULT_GEMINI_VIDEO_POLL_INTERVAL_MS.
 */
export const DEFAULT_GEMINI_VIDEO_POLL_INTERVAL_MS = 2_000;
/**
 * @public
 * @description Configuration constant for DEFAULT_GEMINI_VIDEO_MAX_POLL_MS.
 */
export const DEFAULT_GEMINI_VIDEO_MAX_POLL_MS = 300_000;
/**
 * @public
 * @description Configuration constant for GEMINI_VIDEO_MIN_DURATION_SECONDS.
 */
export const GEMINI_VIDEO_MIN_DURATION_SECONDS = 4;
/**
 * @public
 * @description Configuration constant for GEMINI_VIDEO_MAX_DURATION_SECONDS.
 */
export const GEMINI_VIDEO_MAX_DURATION_SECONDS = 8;

/**
 * @public
 * @description Helper type for GeminiGeneratedVideoPayload.
 */
export type GeminiGeneratedVideoPayload = {
    uri?: string;
    videoBytes?: string;
    mimeType?: string;
};

/**
 * @public
 * @description Helper type for GeminiVideoPollingOptions.
 */
export type GeminiVideoPollingOptions = {
    pollIntervalMs?: number;
    maxPollMs?: number;
    defaultPollIntervalMs: number;
    defaultMaxPollMs: number;
};

/**
 * @public
 * @description Helper type for GeminiVideoExecutionControlsInput.
 */
export type GeminiVideoExecutionControlsInput = {
    pollUntilComplete?: boolean;
    pollIntervalMs?: number;
    maxPollMs?: number;
    includeBase64?: boolean;
};

/**
 * Normalizes poll window values used by long-running Gemini video operations.
 */
/**
 * @public
 * @description Helper utility for resolvePollingWindow.
 * @param options Polling configuration input.
 * @returns Normalized helper result.
 */
export function resolvePollingWindow(options: GeminiVideoPollingOptions): {
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
 * Resolves runtime polling and payload controls used across Gemini video capabilities.
 */
/**
 * @public
 * @description Helper utility for resolveGeminiVideoExecutionControls.
 * @param input Execution control overrides.
 * @returns Normalized helper result.
 */
export function resolveGeminiVideoExecutionControls(input?: GeminiVideoExecutionControlsInput): {
    pollUntilComplete: boolean;
    includeBase64: boolean;
    pollIntervalMs: number;
    maxPollMs: number;
} {
    const { pollIntervalMs, maxPollMs } = resolvePollingWindow({
        pollIntervalMs: input?.pollIntervalMs,
        maxPollMs: input?.maxPollMs,
        defaultPollIntervalMs: DEFAULT_GEMINI_VIDEO_POLL_INTERVAL_MS,
        defaultMaxPollMs: DEFAULT_GEMINI_VIDEO_MAX_POLL_MS
    });

    return {
        pollUntilComplete: input?.pollUntilComplete ?? true,
        includeBase64: input?.includeBase64 ?? false,
        pollIntervalMs,
        maxPollMs
    };
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

export type PollGeminiVideoArgs = {
    client: GoogleGenAI;
    operation: any;
    pollIntervalMs: number;
    maxPollMs: number;
    signal?: AbortSignal;
    abortMessage: string;
    timeoutMessage: (operationName: string) => string;
};

/**
 * Polls a Gemini long-running operation until it reaches `done: true`.
 */
/**
 * @public
 * @description Helper utility for pollGeminiVideoOperationUntilDone.
 * @param args Structured helper arguments.
 * @returns Normalized helper result.
 */
export async function pollGeminiVideoOperationUntilDone(args: PollGeminiVideoArgs): Promise<any> {
    const started = Date.now();
    let current = args.operation;

    while (!current?.done) {
        if (args.signal?.aborted) {
            throw new Error(args.abortMessage);
        }

        if (Date.now() - started >= args.maxPollMs) {
            throw new Error(args.timeoutMessage(current?.name ?? "unknown"));
        }

        await delayWithAbort(args.pollIntervalMs, args.signal, args.abortMessage);
        current = await (args.client.operations as any).getVideosOperation({ operation: current });
    }

    return current;
}

/**
 * Polls only when requested; otherwise returns the initial operation result.
 */
export async function resolveGeminiOperationResult(args: {
    client: GoogleGenAI;
    operation: any;
    pollUntilComplete: boolean;
    pollIntervalMs: number;
    maxPollMs: number;
    signal?: AbortSignal;
    abortMessage: string;
    timeoutMessage: (operationName: string) => string;
}): Promise<any> {
    if (!args.pollUntilComplete) {
        return args.operation;
    }

    return await pollGeminiVideoOperationUntilDone({
        client: args.client,
        operation: args.operation,
        pollIntervalMs: args.pollIntervalMs,
        maxPollMs: args.maxPollMs,
        signal: args.signal,
        abortMessage: args.abortMessage,
        timeoutMessage: args.timeoutMessage
    });
}

/**
 * Converts Gemini file references/URLs into a valid file name token for Files API calls.
 */
/**
 * @public
 * @description Helper utility for extractGeminiFileName.
 * @param source File URI or resource name to parse.
 * @returns Normalized helper result.
 */
export function extractGeminiFileName(source: string): string | undefined {
    const normalize = (raw: string): string | undefined => {
        const decoded = decodeURIComponent(raw.trim());
        if (!decoded || decoded.includes("://")) {
            return undefined;
        }

        const withoutPrefix = decoded.replace(/^files\//, "");
        const base = withoutPrefix.split(":", 1)[0].split("/", 1)[0];
        return VALID_GEMINI_FILE_NAME.test(base) ? base : undefined;
    };

    const direct = normalize(source);
    if (direct) {
        return direct;
    }

    try {
        const parsed = new URL(source);
        const nameParam = parsed.searchParams.get("name");
        if (nameParam) {
            const fromParam = normalize(nameParam);
            if (fromParam) {
                return fromParam;
            }
        }

        const filesMatch = parsed.pathname.match(/\/files\/([^/:?#]+)/i);
        if (filesMatch?.[1]) {
            return normalize(filesMatch[1]);
        }
    } catch {
        return undefined;
    }

    return undefined;
}

/**
 * Attempts an authenticated Files API download using both `files/<name>` and `<name>` reference forms.
 */
export async function downloadGeminiFileViaApi(
    client: GoogleGenAI,
    fileRefOrName: string,
    signal?: AbortSignal
): Promise<Buffer> {
    const normalizedName = extractGeminiFileName(fileRefOrName);
    if (!normalizedName) {
        throw new Error(
            "Gemini video download requires a valid file reference (files/<name> or URL containing /files/<name>)."
        );
    }

    const downloadPath = path.join(tmpdir(), `gemini-video-${crypto.randomUUID()}-${normalizedName}.mp4`);
    const primaryRef = `files/${normalizedName}`;
    const secondaryRef = normalizedName;

    let lastError: unknown;
    try {
        try {
            await (client.files as any).download({
                file: primaryRef,
                downloadPath,
                config: { abortSignal: signal }
            });
            return await readFile(downloadPath);
        } catch (error) {
            lastError = error;
        }

        if (secondaryRef !== primaryRef) {
            try {
                await (client.files as any).download({
                    file: secondaryRef,
                    downloadPath,
                    config: { abortSignal: signal }
                });
                return await readFile(downloadPath);
            } catch (error) {
                lastError = error;
            }
        }

        if (lastError instanceof Error) {
            throw lastError;
        }
        throw new Error("Gemini files.download failed for all attempted file reference formats");
    } finally {
        await unlink(downloadPath).catch(() => undefined);
    }
}

export type ResolveVideoBase64Args = {
    client: GoogleGenAI;
    video: GeminiGeneratedVideoPayload;
    signal?: AbortSignal;
    fetchFailureLabel: string;
};

/**
 * Resolves Gemini video content to base64 from inline bytes, fetchable URI, or Files API fallback.
 */
/**
 * @public
 * @description Helper utility for resolveGeminiVideoBase64.
 * @param args Structured helper arguments.
 * @returns Normalized helper result.
 */
export async function resolveGeminiVideoBase64(args: ResolveVideoBase64Args): Promise<string | undefined> {
    const { video, signal } = args;

    if (video.videoBytes) {
        return video.videoBytes;
    }

    if (!video.uri) {
        return undefined;
    }

    if (video.uri.startsWith("data:")) {
        const b64 = video.uri.split(",", 2)[1];
        return b64 || undefined;
    }

    if (video.uri.startsWith("http://") || video.uri.startsWith("https://")) {
        await assertSafeRemoteHttpUrl(video.uri);
        const response = await fetch(video.uri, { signal });
        if (response.ok) {
            const bytes = Buffer.from(await response.arrayBuffer());
            return bytes.length > 0 ? bytes.toString("base64") : undefined;
        }

        if (response.status === 401 || response.status === 403) {
            const fileName = extractGeminiFileName(video.uri);
            if (!fileName) {
                throw new Error(`${args.fetchFailureLabel}: ${response.status} ${response.statusText}`);
            }
            const bytes = await downloadGeminiFileViaApi(args.client, fileName, signal);
            return bytes.length > 0 ? bytes.toString("base64") : undefined;
        }

        throw new Error(`${args.fetchFailureLabel}: ${response.status} ${response.statusText}`);
    }

    const bytes = await downloadGeminiFileViaApi(args.client, video.uri, signal);
    return bytes.length > 0 ? bytes.toString("base64") : undefined;
}

/**
 * Reads finite numeric value from unknown config input.
 */
/**
 * @public
 * @description Helper utility for readFiniteNumber.
 * @param value Raw value to parse.
 * @returns Normalized helper result.
 */
export function readFiniteNumber(value: unknown): number | undefined {
    if (typeof value === "number" && Number.isFinite(value)) {
        return value;
    }
    if (typeof value === "string" && value.trim().length > 0) {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : undefined;
    }
    return undefined;
}

/**
 * Validates duration bounds and returns normalized numeric seconds.
 */
/**
 * @public
 * @description Helper utility for ensureDurationInRange.
 * @param value Raw value to parse.
 * @param minSeconds Minimum allowed duration.
 * @param maxSeconds Maximum allowed duration.
 * @returns Normalized helper result.
 */
export function ensureDurationInRange(value: number | undefined, minSeconds: number, maxSeconds: number): number | undefined {
    if (value === undefined) {
        return undefined;
    }
    if (!Number.isFinite(value)) {
        throw new Error(`Gemini video durationSeconds must be a finite number (received ${String(value)})`);
    }
    if (value < minSeconds || value > maxSeconds) {
        throw new Error(`Gemini video durationSeconds must be between ${minSeconds} and ${maxSeconds} (received ${value})`);
    }
    return value;
}

/**
 * Resolves durationSeconds from request/config values and validates provider bounds.
 *
 * For string inputs, this keeps generation behavior:
 * non-numeric strings are treated as "unset" rather than throwing.
 */
export function resolveGeminiDurationSeconds(
    value: string | number | undefined,
    minSeconds: number,
    maxSeconds: number
): number | undefined {
    if (value === undefined) {
        return undefined;
    }

    if (typeof value === "string") {
        const parsed = Number.parseInt(value, 10);
        if (!Number.isFinite(parsed)) {
            return undefined;
        }
        return ensureDurationInRange(parsed, minSeconds, maxSeconds);
    }

    return ensureDurationInRange(value, minSeconds, maxSeconds);
}

/**
 * Resolves the stable artifact/response id for Gemini video operations.
 */
/**
 * @public
 * @description Helper utility for resolveGeminiOperationId.
 * @param finalOperation Final operation payload from polling.
 * @returns Normalized helper result.
 */
export function resolveGeminiOperationId(finalOperation: any): string {
    return finalOperation?.name ?? crypto.randomUUID();
}

/**
 * Extracts the first generated video payload from a terminal operation response.
 */
export function extractGeneratedVideoOrThrow(
    finalOperation: any,
    missingVideoErrorMessage: string
): GeminiGeneratedVideoPayload {
    const generatedVideo = finalOperation?.response?.generatedVideos?.[0]?.video as GeminiGeneratedVideoPayload | undefined;
    if (!generatedVideo) {
        throw new Error(missingVideoErrorMessage);
    }
    return generatedVideo;
}

/**
 * Throws when Gemini operation payload contains an error object.
 */
/**
 * @public
 * @description Helper utility for throwIfGeminiOperationFailed.
 * @param operation Operation payload to validate.
 * @param errorMessage Fallback error message when provider does not return one.
 * @returns Normalized helper result.
 */
export function throwIfGeminiOperationFailed(operation: any, errorMessage: string): void {
    if (operation?.error) {
        throw new Error(`${errorMessage}: ${JSON.stringify(operation.error)}`);
    }
}

export type BuildGeminiVideoArtifactArgs = {
    id: string;
    video: GeminiGeneratedVideoPayload;
    base64?: string;
    durationSeconds?: number;
    model: string | undefined;
    operationName: string | undefined;
    done: boolean | undefined;
    requestId: string | undefined;
};

/**
 * Creates a normalized video artifact with consistent Gemini metadata shape.
 */
/**
 * @public
 * @description Helper utility for buildGeminiVideoArtifact.
 * @param args Structured helper arguments.
 * @returns Normalized helper result.
 */
export function buildGeminiVideoArtifact(args: BuildGeminiVideoArtifactArgs): NormalizedVideo {
    return {
        id: args.id,
        mimeType: args.video.mimeType ?? "video/mp4",
        ...(args.video.uri ? { url: args.video.uri } : {}),
        ...(args.base64 ? { base64: args.base64 } : {}),
        ...(args.durationSeconds !== undefined ? { durationSeconds: args.durationSeconds } : {}),
        raw: args.video,
        metadata: {
            provider: AIProvider.Gemini,
            model: args.model,
            operationName: args.operationName,
            done: args.done,
            requestId: args.requestId
        }
    };
}

export type BuildGeminiVideoResponseMetadataArgs = {
    contextMetadata?: Record<string, unknown>;
    model: string | undefined;
    operationName: string | undefined;
    done: boolean | undefined;
    requestId: string | undefined;
};

/**
 * Builds top-level AIResponse metadata shared by Gemini video capabilities.
 */
/**
 * @public
 * @description Helper utility for buildGeminiVideoResponseMetadata.
 * @param args Structured helper arguments.
 * @returns Normalized helper result.
 */
export function buildGeminiVideoResponseMetadata(args: BuildGeminiVideoResponseMetadataArgs): Record<string, unknown> {
    return {
        ...(args.contextMetadata ?? {}),
        provider: AIProvider.Gemini,
        model: args.model,
        operationName: args.operationName,
        done: args.done,
        requestId: args.requestId
    };
}
