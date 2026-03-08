import { readFile, unlink } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { GoogleGenAI } from "@google/genai";
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
 * Gemini video download capability implementation.
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
        const { input, context } = request;

        const source = input?.videoUri ?? input?.videoId;
        if (!source) {
            throw new Error("videoUri or videoId is required for Gemini video download");
        }

        const bytes = await this.resolveDownloadBytes(source, signal);
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
        const normalize = (raw: string): string | undefined => {
            const decoded = decodeURIComponent(raw.trim());
            if (!decoded) {
                return undefined;
            }
            // Full URLs are not valid Gemini file names and must be parsed separately.
            if (decoded.includes("://")) {
                return undefined;
            }
            const withoutPrefix = decoded.replace(/^files\//, "");
            // Keep only the file-name token and drop known suffix forms (e.g. :download).
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

            return undefined;
        } catch {
            return undefined;
        }
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
