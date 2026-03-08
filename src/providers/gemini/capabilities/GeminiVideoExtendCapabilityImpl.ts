import { readFile, unlink } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { GoogleGenAI } from "@google/genai";
import {
    AIProvider,
    AIRequest,
    AIResponse,
    BaseProvider,
    CapabilityKeys,
    ClientVideoExtendRequest,
    MultiModalExecutionContext,
    NormalizedVideo,
    VideoExtendCapability
} from "#root/index.js";

const DEFAULT_VIDEO_POLL_INTERVAL_MS = 2_000;
const DEFAULT_VIDEO_MAX_POLL_MS = 300_000;
const GEMINI_VIDEO_MIN_DURATION_SECONDS = 4;
const GEMINI_VIDEO_MAX_DURATION_SECONDS = 8;

/**
 * Gemini video extension capability implementation.
 */
export class GeminiVideoExtendCapabilityImpl implements VideoExtendCapability<ClientVideoExtendRequest, NormalizedVideo[]> {
    constructor(
        private readonly provider: BaseProvider,
        private readonly client: GoogleGenAI
    ) {}

    async extendVideo(
        request: AIRequest<ClientVideoExtendRequest>,
        _executionContext?: MultiModalExecutionContext,
        signal?: AbortSignal
    ): Promise<AIResponse<NormalizedVideo[]>> {
        this.provider.ensureInitialized();
        const { input, options, context } = request;

        if (!input?.sourceVideoUri && !input?.sourceVideoBase64) {
            throw new Error("sourceVideoUri or sourceVideoBase64 is required for Gemini video extension");
        }

        const merged = this.provider.getMergedOptions(CapabilityKeys.VideoExtendCapabilityKey, {
            model: options?.model ?? input.params?.model,
            modelParams: options?.modelParams,
            providerParams: options?.providerParams,
            generalParams: options?.generalParams
        });

        const durationSeconds = this.resolveDurationSeconds(
            input.params?.durationSeconds ??
                this.readFiniteNumber((merged.modelParams as Record<string, unknown> | undefined)?.durationSeconds) ??
                this.readFiniteNumber((merged.providerParams as Record<string, unknown> | undefined)?.durationSeconds)
        );
        const config: Record<string, unknown> = {
            ...(merged.modelParams ?? {}),
            ...(merged.providerParams ?? {}),
            ...(input.params?.aspectRatio ? { aspectRatio: input.params.aspectRatio } : {}),
            ...(input.params?.resolution ? { resolution: input.params.resolution } : {})
        };
        if (durationSeconds !== undefined) {
            config.durationSeconds = durationSeconds;
        }

        const operation = await (this.client.models as any).generateVideos({
            model: merged.model,
            source: {
                ...(input.prompt ? { prompt: input.prompt } : {}),
                video: {
                    ...(input.sourceVideoUri ? { uri: input.sourceVideoUri } : {}),
                    ...(input.sourceVideoBase64 ? { videoBytes: input.sourceVideoBase64 } : {}),
                    ...(input.sourceVideoMimeType ? { mimeType: input.sourceVideoMimeType } : {})
                }
            },
            config
        });

        const pollUntilComplete = input.params?.pollUntilComplete ?? true;
        const pollIntervalMs = Math.max(250, Number(input.params?.pollIntervalMs ?? DEFAULT_VIDEO_POLL_INTERVAL_MS));
        const maxPollMs = Math.max(pollIntervalMs, Number(input.params?.maxPollMs ?? DEFAULT_VIDEO_MAX_POLL_MS));
        const includeBase64 = input.params?.includeBase64 ?? false;

        const finalOperation = pollUntilComplete
            ? await this.pollUntilTerminal(operation, pollIntervalMs, maxPollMs, signal)
            : operation;

        if (finalOperation?.error) {
            throw new Error(
                `Gemini video extension failed (model=${String(merged.model)}, durationSeconds=${
                    durationSeconds ?? "unset"
                }): ${JSON.stringify(finalOperation.error)}`
            );
        }

        const generatedVideo = finalOperation?.response?.generatedVideos?.[0]?.video as
            | { uri?: string; videoBytes?: string; mimeType?: string }
            | undefined;
        if (!generatedVideo) {
            throw new Error("Gemini video extension response did not include a generated video");
        }

        const base64 = includeBase64 ? await this.resolveVideoBase64(generatedVideo, signal) : undefined;

        const output: NormalizedVideo[] = [
            {
                id: finalOperation?.name ?? crypto.randomUUID(),
                mimeType: generatedVideo.mimeType ?? "video/mp4",
                ...(generatedVideo.uri ? { url: generatedVideo.uri } : {}),
                ...(base64 ? { base64 } : {}),
                ...(durationSeconds !== undefined ? { durationSeconds } : {}),
                raw: generatedVideo,
                metadata: {
                    provider: AIProvider.Gemini,
                    model: merged.model,
                    operationName: finalOperation?.name,
                    done: finalOperation?.done,
                    requestId: context?.requestId
                }
            }
        ];

        return {
            output,
            multimodalArtifacts: { video: output },
            rawResponse: finalOperation,
            id: finalOperation?.name ?? crypto.randomUUID(),
            metadata: {
                ...(context?.metadata ?? {}),
                provider: AIProvider.Gemini,
                model: merged.model,
                operationName: finalOperation?.name,
                done: finalOperation?.done,
                requestId: context?.requestId
            }
        };
    }

    private async pollUntilTerminal(operation: any, pollIntervalMs: number, maxPollMs: number, signal?: AbortSignal) {
        const started = Date.now();
        let current = operation;

        while (!current?.done) {
            if (signal?.aborted) {
                throw new Error("Gemini video extension polling aborted");
            }

            if (Date.now() - started >= maxPollMs) {
                throw new Error(`Timed out waiting for Gemini video operation '${current?.name ?? "unknown"}'`);
            }

            await this.delay(pollIntervalMs, signal);
            current = await (this.client.operations as any).getVideosOperation({ operation: current });
        }

        return current;
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
                reject(new Error("Gemini video extension polling aborted"));
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

    private resolveDurationSeconds(value?: number): number | undefined {
        if (value === undefined) {
            return undefined;
        }
        if (!Number.isFinite(value)) {
            throw new Error(`Gemini video durationSeconds must be a finite number (received ${String(value)})`);
        }
        if (value < GEMINI_VIDEO_MIN_DURATION_SECONDS || value > GEMINI_VIDEO_MAX_DURATION_SECONDS) {
            throw new Error(
                `Gemini video durationSeconds must be between ${GEMINI_VIDEO_MIN_DURATION_SECONDS} and ${GEMINI_VIDEO_MAX_DURATION_SECONDS} (received ${value})`
            );
        }
        return value;
    }

    private readFiniteNumber(value: unknown): number | undefined {
        if (typeof value === "number" && Number.isFinite(value)) {
            return value;
        }
        if (typeof value === "string" && value.trim().length > 0) {
            const parsed = Number(value);
            return Number.isFinite(parsed) ? parsed : undefined;
        }
        return undefined;
    }

    private async resolveVideoBase64(
        video: { uri?: string; videoBytes?: string; mimeType?: string },
        signal?: AbortSignal
    ): Promise<string | undefined> {
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
            const response = await fetch(video.uri, { signal });
            if (response.ok) {
                const bytes = Buffer.from(await response.arrayBuffer());
                return bytes.length > 0 ? bytes.toString("base64") : undefined;
            }

            if (response.status === 401 || response.status === 403) {
                const fileName = this.extractGeminiFileName(video.uri);
                if (!fileName) {
                    throw new Error(`Failed to fetch extended video from URI: ${response.status} ${response.statusText}`);
                }
                const bytes = await this.downloadViaFilesApi(fileName, signal);
                return bytes.length > 0 ? bytes.toString("base64") : undefined;
            }

            throw new Error(`Failed to fetch extended video from URI: ${response.status} ${response.statusText}`);
        }

        const bytes = await this.downloadViaFilesApi(video.uri, signal);
        return bytes.length > 0 ? bytes.toString("base64") : undefined;
    }

    private extractGeminiFileName(source: string): string | undefined {
        const normalize = (raw: string): string | undefined => {
            const decoded = decodeURIComponent(raw.trim());
            if (!decoded || decoded.includes("://")) {
                return undefined;
            }
            const withoutPrefix = decoded.replace(/^files\//, "");
            const base = withoutPrefix.split(":", 1)[0].split("/", 1)[0];
            if (/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(base)) {
                return base;
            }
            return undefined;
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
                const fromPath = normalize(filesMatch[1]);
                if (fromPath) {
                    return fromPath;
                }
            }
        } catch {
            return undefined;
        }

        return undefined;
    }

    private async downloadViaFilesApi(fileRefOrName: string, signal?: AbortSignal): Promise<Buffer> {
        const normalizedName = this.extractGeminiFileName(fileRefOrName);
        if (!normalizedName) {
            throw new Error(
                "Gemini video download requires a valid file reference (files/<name> or URL containing /files/<name>)."
            );
        }

        const fileName = normalizedName;
        const downloadPath = path.join(tmpdir(), `gemini-video-${Date.now()}-${fileName}.mp4`);
        const downloadRefs = Array.from(new Set([`files/${normalizedName}`, normalizedName]));

        let lastError: unknown;
        try {
            for (const ref of downloadRefs) {
                try {
                    await (this.client.files as any).download({
                        file: ref,
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
}
