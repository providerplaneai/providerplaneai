/**
 * @module providers/gemini/capabilities/GeminiVideoDownloadCapabilityImpl.ts
 * @description Provider implementations and capability adapters.
 */
import { GoogleGenAI } from "@google/genai";
import {
    AIProvider,
    AIRequest,
    AIResponse,
    BaseProvider,
    CapabilityKeys,
    ClientVideoDownloadRequest,
    MultiModalExecutionContext,
    NormalizedVideo,
    assertSafeRemoteHttpUrl,
    VideoDownloadCapability
} from "#root/index.js";
import {
    downloadGeminiFileViaApi,
    extractGeminiFileName
} from "#root/providers/gemini/capabilities/shared/GeminiVideoUtils.js";

const DEFAULT_VIDEO_DOWNLOAD_TIMEOUT_MS = 30_000;

/**
 * Gemini video download capability implementation.
 */
/**
 * @public
 * @description Provider capability implementation for GeminiVideoDownloadCapabilityImpl.
 */
export class GeminiVideoDownloadCapabilityImpl implements VideoDownloadCapability<
    ClientVideoDownloadRequest,
    NormalizedVideo[]
> {
    constructor(
        private readonly provider: BaseProvider,
        private readonly client: GoogleGenAI
    ) {}

    async downloadVideo(
        request: AIRequest<ClientVideoDownloadRequest>,
        _executionContext?: MultiModalExecutionContext,
        signal?: AbortSignal
    ): Promise<AIResponse<NormalizedVideo[]>> {
        this.provider.ensureInitialized();
        const { input, options, context } = request;

        const source = input?.videoUri ?? input?.videoId;
        if (!source) {
            throw new Error("videoUri or videoId is required for Gemini video download");
        }

        const merged = this.provider.getMergedOptions(CapabilityKeys.VideoDownloadCapabilityKey, options);
        const timeoutMs = this.resolveDownloadTimeoutMs(merged?.generalParams?.downloadTimeoutMs);
        const effectiveSignal = this.composeSignalWithTimeout(signal, timeoutMs);

        const bytes = await this.resolveDownloadBytes(source, effectiveSignal);
        const base64 = bytes.length > 0 ? bytes.toString("base64") : undefined;
        const id = `gemini-download-${crypto.randomUUID()}`;
        const mimeType = this.resolveMimeType(source);

        const output: NormalizedVideo[] = [
            {
                id,
                mimeType,
                ...(source.startsWith("http://") || source.startsWith("https://") ? { url: source } : {}),
                ...(base64 ? { base64 } : {}),
                metadata: {
                    provider: AIProvider.Gemini,
                    source,
                    requestId: context?.requestId
                }
            }
        ];

        return {
            output,
            multimodalArtifacts: { video: output },
            rawResponse: { source, bytes: bytes.length },
            id,
            metadata: {
                ...(context?.metadata ?? {}),
                provider: AIProvider.Gemini,
                source,
                downloadTimeoutMs: timeoutMs,
                bytes: bytes.length,
                requestId: context?.requestId
            }
        };
    }

    private async resolveDownloadBytes(source: string, signal?: AbortSignal): Promise<Buffer> {
        if (source.startsWith("data:")) {
            const b64 = source.split(",", 2)[1] ?? "";
            return Buffer.from(b64, "base64");
        }

        if (source.startsWith("http://") || source.startsWith("https://")) {
            await assertSafeRemoteHttpUrl(source);
            const response = await fetch(source, { signal });
            if (response.ok) {
                return Buffer.from(await response.arrayBuffer());
            }

            // Gemini often returns provider-protected URIs that cannot be fetched anonymously.
            // On auth-style failures, attempt authenticated download through Files API.
            if (response.status === 401 || response.status === 403) {
                const fileName = this.extractGeminiFileName(source);
                if (!fileName) {
                    throw new Error(`Failed to fetch video URI: ${response.status} ${response.statusText}`);
                }
                return await this.downloadViaFilesApi(fileName, signal);
            }

            throw new Error(`Failed to fetch video URI: ${response.status} ${response.statusText}`);
        }

        return await this.downloadViaFilesApi(source, signal);
    }

    private resolveMimeType(source: string): string {
        if (source.startsWith("data:image/") || /\.(jpe?g|png)$/i.test(source)) {
            return "image/jpeg";
        }
        return "video/mp4";
    }

    private extractGeminiFileName(source: string): string | undefined {
        return extractGeminiFileName(source);
    }

    private async downloadViaFilesApi(fileRefOrName: string, signal?: AbortSignal): Promise<Buffer> {
        return await downloadGeminiFileViaApi(this.client, fileRefOrName, signal);
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
