/**
 * @module providers/gemini/capabilities/GeminiVideoAnalysisCapabilityImpl.ts
 * @description Gemini video analysis capability adapter.
 */
import { GoogleGenAI } from "@google/genai";
import {
    AIProvider,
    AIRequest,
    AIResponse,
    BaseProvider,
    CapabilityKeys,
    ClientVideoAnalysisRequest,
    MultiModalExecutionContext,
    NormalizedVideoAnalysis,
    resolveReferenceMediaSource,
    VideoAnalysisCapability,
    parseBestEffortJson,
    buildMetadata
} from "#root/index.js";

const DEFAULT_GEMINI_VIDEO_ANALYSIS_MODEL = "gemini-2.5-pro";
const DEFAULT_VIDEO_ANALYSIS_PROMPT =
    "Analyze this video and provide a concise summary, key events, important entities, and any visible text.";
const DEFAULT_VIDEO_MIME_TYPE = "video/mp4";
const JSON_ANALYSIS_SCHEMA_HINT = `{"summary"?:string,"transcript"?:string,"tags"?:string[],"moments"?:{"timestampSeconds"?:number,"text"?:string}[]}`;

type GeminiVideoAnalysisPayload = {
    summary?: string;
    transcript?: string;
    tags?: string[];
    moments?: Array<{
        timestampSeconds?: number;
        text?: string;
    }>;
};

type RequestedVideo = NonNullable<ClientVideoAnalysisRequest["videos"]>[number];

/**
 * Gemini implementation of provider-agnostic video analysis.
 *
 * Input videos can be provided directly on the request, or implicitly sourced from
 * `MultiModalExecutionContext` when the request omits `input.videos`.
 */
/**
 * @public
 * @description Provider capability implementation for GeminiVideoAnalysisCapabilityImpl.
 */
export class GeminiVideoAnalysisCapabilityImpl implements VideoAnalysisCapability<
    ClientVideoAnalysisRequest,
    NormalizedVideoAnalysis[]
> {
    constructor(
        private readonly provider: BaseProvider,
        private readonly client: GoogleGenAI
    ) {}

    async analyzeVideo(
        request: AIRequest<ClientVideoAnalysisRequest>,
        executionContext?: MultiModalExecutionContext,
        signal?: AbortSignal
    ): Promise<AIResponse<NormalizedVideoAnalysis[]>> {
        this.provider.ensureInitialized();

        if (signal?.aborted) {
            throw new Error("Video analysis aborted before API call");
        }

        const { input, options, context } = request;
        const merged = this.provider.getMergedOptions(CapabilityKeys.VideoAnalysisCapabilityKey, options);
        const outputFormat = input?.params?.outputFormat ?? "json";
        const defaultPrompt =
            typeof merged.generalParams?.defaultPrompt === "string" && merged.generalParams.defaultPrompt.trim().length > 0
                ? merged.generalParams.defaultPrompt
                : DEFAULT_VIDEO_ANALYSIS_PROMPT;
        const defaultMimeType =
            typeof merged.generalParams?.defaultVideoMimeType === "string" &&
            merged.generalParams.defaultVideoMimeType.trim().length > 0
                ? merged.generalParams.defaultVideoMimeType
                : DEFAULT_VIDEO_MIME_TYPE;

        // Prefer explicit request videos; otherwise analyze the latest timeline video artifacts.
        const requestedVideos = input?.videos ?? [];
        const videos = requestedVideos.length > 0 ? requestedVideos : this.mapContextVideos(executionContext);
        if (!videos.length) {
            throw new Error("At least one video is required for video analysis");
        }

        const output: NormalizedVideoAnalysis[] = [];
        const rawResponses: unknown[] = [];

        for (const video of videos) {
            const response = await this.client.models.generateContent({
                model: merged.model ?? DEFAULT_GEMINI_VIDEO_ANALYSIS_MODEL,
                contents: this.buildContents(video, input?.prompt, outputFormat, defaultPrompt, defaultMimeType),
                config: {
                    temperature: input?.params?.temperature ?? 0,
                    maxOutputTokens: input?.params?.maxOutputTokens,
                    ...(merged.modelParams ?? {})
                },
                // Keep provider-specific knobs passthrough for forward compatibility.
                ...(merged.providerParams ?? {})
            });
            rawResponses.push(response);

            const text = response.text ?? "";
            output.push(
                this.normalizeVideoAnalysis(
                    video.id,
                    text,
                    outputFormat === "json" ? parseBestEffortJson<GeminiVideoAnalysisPayload>(text) : undefined
                )
            );
        }

        return {
            output,
            multimodalArtifacts: { videoAnalysis: output },
            rawResponse: rawResponses,
            id: context?.requestId ?? crypto.randomUUID(),
            metadata: buildMetadata(context?.metadata, {
                provider: AIProvider.Gemini,
                model: merged.model ?? DEFAULT_GEMINI_VIDEO_ANALYSIS_MODEL,
                status: "completed",
                requestId: context?.requestId,
                analyzedVideos: output.length
            })
        };
    }

    /**
     * Maps timeline videos into the request shape expected by analysis input.
     */
    private mapContextVideos(executionContext?: MultiModalExecutionContext): NonNullable<ClientVideoAnalysisRequest["videos"]> {
        const videos = executionContext?.getLatestVideo() ?? [];
        return videos.map((v) => ({
            id: v.id,
            mimeType: v.mimeType,
            url: v.url,
            base64: v.base64
        }));
    }

    /**
     * Builds a Gemini `generateContent` payload for one video input.
     *
     * In `json` mode we instruct the model to return strict JSON so downstream parsing
     * can populate structured fields (summary/tags/moments).
     */
    private buildContents(
        video: RequestedVideo,
        prompt: string | undefined,
        outputFormat: NonNullable<ClientVideoAnalysisRequest["params"]>["outputFormat"],
        defaultPrompt: string,
        defaultMimeType: string
    ) {
        const parts: Array<Record<string, unknown>> = [];
        const promptText = prompt ?? defaultPrompt;

        if (outputFormat === "json") {
            parts.push({
                text: `${promptText}\n\nReturn only valid JSON matching this interface: ${JSON_ANALYSIS_SCHEMA_HINT}`
            });
        } else {
            parts.push({ text: promptText });
        }

        const resolved = resolveReferenceMediaSource(video, defaultMimeType, "Each video must include either base64 or url");

        if (resolved.kind === "base64") {
            parts.push({
                inlineData: {
                    mimeType: resolved.mimeType,
                    data: resolved.base64
                }
            });
        } else {
            parts.push({
                fileData: {
                    mimeType: resolved.mimeType,
                    fileUri: resolved.url
                }
            });
        }

        return [{ role: "user", parts }];
    }

    /**
     * Normalizes Gemini model text output into `NormalizedVideoAnalysis`.
     *
     * If parsed JSON is unavailable, plain text is preserved as `summary` so analysis
     * still returns useful output in non-JSON or degraded model responses.
     */
    private normalizeVideoAnalysis(
        sourceVideoId: string | undefined,
        text: string,
        parsed?: GeminiVideoAnalysisPayload | GeminiVideoAnalysisPayload[]
    ): NormalizedVideoAnalysis {
        const normalized = Array.isArray(parsed) ? parsed[0] : parsed;
        const fallbackSummary = text.trim().length > 0 ? text : undefined;
        return {
            id: sourceVideoId ?? crypto.randomUUID(),
            sourceVideoId,
            summary: normalized?.summary ?? fallbackSummary,
            transcript: normalized?.transcript,
            tags: normalized?.tags?.filter(Boolean),
            moments: normalized?.moments
                ?.filter((m) => Boolean(m?.text))
                .map((m) => ({
                    timestampSeconds: m.timestampSeconds,
                    text: m.text!
                }))
        };
    }
}
