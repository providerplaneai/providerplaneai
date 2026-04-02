/**
 * @module providers/gemini/capabilities/shared/GeminiVideoUtils.ts
 * @description Shared Gemini video polling, download, and normalization helpers.
 */
import { GoogleGenAI } from "@google/genai";
import {
    AIProvider,
    NormalizedVideo,
    assertSafeRemoteHttpUrl,
    buildMetadata,
    createTempFilePath,
    delayWithAbort as sharedDelayWithAbort,
    readFileToBuffer,
    resolvePollingWindow as resolveSharedPollingWindow,
    removeFileIfExists
} from "#root/index.js";

const MIN_VIDEO_POLL_INTERVAL_MS = 250;
const VALID_GEMINI_FILE_NAME = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

/**
 * @public
 * Default poll interval used by Gemini video operations.
 */
export const DEFAULT_GEMINI_VIDEO_POLL_INTERVAL_MS = 2_000;
/**
 * @public
 * Default maximum polling duration used by Gemini video operations.
 */
export const DEFAULT_GEMINI_VIDEO_MAX_POLL_MS = 300_000;
/**
 * @public
 * Minimum allowed Gemini video duration in seconds.
 */
export const GEMINI_VIDEO_MIN_DURATION_SECONDS = 4;
/**
 * @public
 * Maximum allowed Gemini video duration in seconds.
 */
export const GEMINI_VIDEO_MAX_DURATION_SECONDS = 8;

/**
 * @public
 * Provider payload shape for generated Gemini video content.
 */
export type GeminiGeneratedVideoPayload = {
    uri?: string;
    videoBytes?: string;
    mimeType?: string;
};

/**
 * @public
 * Polling configuration input for Gemini long-running operations.
 */
export type GeminiVideoPollingOptions = {
    pollIntervalMs?: number;
    maxPollMs?: number;
    defaultPollIntervalMs: number;
    defaultMaxPollMs: number;
};

/**
 * @public
 * Runtime execution-control overrides for Gemini video capabilities.
 */
export type GeminiVideoExecutionControlsInput = {
    pollUntilComplete?: boolean;
    pollIntervalMs?: number;
    maxPollMs?: number;
    includeBase64?: boolean;
};

/**
 * Normalizes poll window values used by long-running Gemini video operations.
 *
 * @param {GeminiVideoPollingOptions} options - Polling configuration input.
 * @returns {{ pollIntervalMs: number; maxPollMs: number }} Normalized polling window.
 */
export function resolveGeminiPollingWindow(options: GeminiVideoPollingOptions): {
    pollIntervalMs: number;
    maxPollMs: number;
} {
    return resolveSharedPollingWindow({
        ...options,
        minPollIntervalMs: MIN_VIDEO_POLL_INTERVAL_MS
    });
}

/**
 * Resolves runtime polling and payload controls used across Gemini video capabilities.
 *
 * @param {GeminiVideoExecutionControlsInput | undefined} input - Execution control overrides.
 * @returns {{ pollUntilComplete: boolean; includeBase64: boolean; pollIntervalMs: number; maxPollMs: number }} Normalized execution controls.
 */
export function resolveGeminiVideoExecutionControls(input?: GeminiVideoExecutionControlsInput): {
    pollUntilComplete: boolean;
    includeBase64: boolean;
    pollIntervalMs: number;
    maxPollMs: number;
} {
    const { pollIntervalMs, maxPollMs } = resolveGeminiPollingWindow({
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
 *
 * @param {PollGeminiVideoArgs} args - Structured helper arguments.
 * @returns {Promise<any>} Final completed operation payload.
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

        await sharedDelayWithAbort(args.pollIntervalMs, args.signal, args.abortMessage);
        current = await (args.client.operations as any).getVideosOperation({ operation: current });
    }

    return current;
}

/**
 * Polls only when requested; otherwise returns the initial operation result.
 *
 * @param {{ client: GoogleGenAI; operation: any; pollUntilComplete: boolean; pollIntervalMs: number; maxPollMs: number; signal?: AbortSignal; abortMessage: string; timeoutMessage: (operationName: string) => string; }} args - Structured polling arguments.
 * @returns {Promise<any>} Initial or final operation payload depending on polling mode.
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
 * Converts Gemini file references and URLs into a valid file-name token for Files API calls.
 *
 * @param {string} source - File URI or resource name to parse.
 * @returns {string | undefined} Normalized Gemini file name when one can be extracted.
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
 *
 * @param {GoogleGenAI} client - Gemini SDK client.
 * @param {string} fileRefOrName - File reference or file name to download.
 * @param {AbortSignal | undefined} signal - Optional abort signal.
 * @returns {Promise<Buffer>} Downloaded file bytes.
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

    const downloadPath = await createTempFilePath(`gemini-video-${normalizedName}`, "mp4");
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
            return await readFileToBuffer(downloadPath);
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
                return await readFileToBuffer(downloadPath);
            } catch (error) {
                lastError = error;
            }
        }

        if (lastError instanceof Error) {
            throw lastError;
        }
        throw new Error("Gemini files.download failed for all attempted file reference formats");
    } finally {
        await removeFileIfExists(downloadPath);
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
 *
 * @param {ResolveVideoBase64Args} args - Structured helper arguments.
 * @returns {Promise<string | undefined>} Base64 payload when video content can be resolved.
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
 * Reads a finite numeric value from unknown config input.
 *
 * @param {unknown} value - Raw value to parse.
 * @returns {number | undefined} Parsed finite number when valid.
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
 *
 * @param {number | undefined} value - Raw value to validate.
 * @param {number} minSeconds - Minimum allowed duration.
 * @param {number} maxSeconds - Maximum allowed duration.
 * @returns {number | undefined} Normalized duration value.
 * @throws {Error} When the provided duration is non-finite or outside the allowed range.
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
 *
 * @param {string | number | undefined} value - Raw duration value from request or config.
 * @param {number} minSeconds - Minimum allowed duration.
 * @param {number} maxSeconds - Maximum allowed duration.
 * @returns {number | undefined} Normalized duration in seconds.
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
 * Resolves the stable artifact or response identifier for Gemini video operations.
 *
 * @param {any} finalOperation - Final operation payload from polling.
 * @returns {string} Stable identifier for artifacts and responses.
 */
export function resolveGeminiOperationId(finalOperation: any): string {
    return finalOperation?.name ?? crypto.randomUUID();
}

/**
 * Extracts the first generated video payload from a terminal operation response.
 *
 * @param {any} finalOperation - Final terminal operation payload.
 * @param {string} missingVideoErrorMessage - Error to throw when no generated video is present.
 * @returns {GeminiGeneratedVideoPayload} First generated video payload.
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
 * Throws when a Gemini operation payload contains an error object.
 *
 * @param {any} operation - Operation payload to validate.
 * @param {string} errorMessage - Fallback error message when the provider does not return one.
 * @throws {Error} When the operation contains an error payload.
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
 *
 * @param {BuildGeminiVideoArtifactArgs} args - Structured helper arguments.
 * @returns {NormalizedVideo} Normalized video artifact.
 */
export function buildGeminiVideoArtifact(args: BuildGeminiVideoArtifactArgs): NormalizedVideo {
    return {
        id: args.id,
        mimeType: args.video.mimeType ?? "video/mp4",
        ...(args.video.uri ? { url: args.video.uri } : {}),
        ...(args.base64 ? { base64: args.base64 } : {}),
        ...(args.durationSeconds !== undefined ? { durationSeconds: args.durationSeconds } : {}),
        raw: args.video,
        metadata: buildMetadata(undefined, {
            provider: AIProvider.Gemini,
            model: args.model,
            operationName: args.operationName,
            done: args.done,
            requestId: args.requestId
        })
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
 * Builds top-level `AIResponse` metadata shared by Gemini video capabilities.
 *
 * @param {BuildGeminiVideoResponseMetadataArgs} args - Structured helper arguments.
 * @returns {Record<string, unknown>} Top-level response metadata object.
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
