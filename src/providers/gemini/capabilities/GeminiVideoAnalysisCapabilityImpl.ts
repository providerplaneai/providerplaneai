import { GoogleGenAI } from "@google/genai";
import {
    AIProvider,
    AIRequest,
    AIResponse,
    BaseProvider,
    CapabilityKeys,
    ClientVideoAnalysisRequest,
    MultiModalExecutionContext,
    NormalizedVideo,
    NormalizedVideoAnalysis,
    VideoAnalysisCapability,
    parseBestEffortJson
} from "#root/index.js";

const DEFAULT_GEMINI_VIDEO_ANALYSIS_MODEL = "gemini-2.5-pro";
const DEFAULT_VIDEO_ANALYSIS_PROMPT =
    "Analyze this video and provide a concise summary, key events, important entities, and any visible text.";

type GeminiVideoAnalysisPayload = {
    summary?: string;
    transcript?: string;
    tags?: string[];
    moments?: Array<{
        timestampSeconds?: number;
        text?: string;
    }>;
};

export class GeminiVideoAnalysisCapabilityImpl
    implements VideoAnalysisCapability<ClientVideoAnalysisRequest, NormalizedVideoAnalysis[]>
{
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
        const { input, options, context } = request;
        const merged = this.provider.getMergedOptions(CapabilityKeys.VideoAnalysisCapabilityKey, options);
        const outputFormat = input?.params?.outputFormat ?? "json";

        const requestedVideos = input?.videos ?? [];
        const contextVideos = executionContext?.getLatestVideo() ?? [];
        const videos: NonNullable<ClientVideoAnalysisRequest["videos"]> =
            requestedVideos.length > 0 ? requestedVideos : this.convertContextVideos(contextVideos);
        if (!videos.length) {
            throw new Error("At least one video is required for video analysis");
        }

        const output: NormalizedVideoAnalysis[] = [];
        const rawResponses: unknown[] = [];
        for (const video of videos) {
            const response = await this.client.models.generateContent({
                model: merged.model ?? DEFAULT_GEMINI_VIDEO_ANALYSIS_MODEL,
                contents: this.buildContents(video, input?.prompt, outputFormat),
                config: {
                    temperature: input?.params?.temperature ?? 0,
                    maxOutputTokens: input?.params?.maxOutputTokens,
                    ...(merged.modelParams ?? {})
                },
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
            multimodalArtifacts: { analysis: output },
            rawResponse: rawResponses,
            id: context?.requestId ?? crypto.randomUUID(),
            metadata: {
                ...(context?.metadata ?? {}),
                provider: AIProvider.Gemini,
                model: merged.model ?? DEFAULT_GEMINI_VIDEO_ANALYSIS_MODEL,
                status: "completed",
                requestId: context?.requestId,
                analyzedVideos: output.length
            }
        };
    }

    private convertContextVideos(videos: NormalizedVideo[]): NonNullable<ClientVideoAnalysisRequest["videos"]> {
        return videos.map(v => ({
            id: v.id,
            mimeType: v.mimeType,
            url: v.url,
            base64: v.base64
        }));
    }

    private buildContents(
        video: NonNullable<ClientVideoAnalysisRequest["videos"]>[number],
        prompt: string | undefined,
        outputFormat: NonNullable<ClientVideoAnalysisRequest["params"]>["outputFormat"]
    ) {
        const parts: Array<Record<string, unknown>> = [];
        if (outputFormat === "json") {
            parts.push({
                text:
                    `${prompt ?? DEFAULT_VIDEO_ANALYSIS_PROMPT}\n\n` +
                    "Return only valid JSON matching this interface: " +
                    `{"summary"?:string,"transcript"?:string,"tags"?:string[],"moments"?:{"timestampSeconds"?:number,"text"?:string}[]}`
            });
        } else {
            parts.push({ text: prompt ?? DEFAULT_VIDEO_ANALYSIS_PROMPT });
        }

        if (video.base64) {
            parts.push({
                inlineData: {
                    mimeType: video.mimeType ?? "video/mp4",
                    data: video.base64
                }
            });
        } else if (video.url) {
            parts.push({
                fileData: {
                    mimeType: video.mimeType ?? "video/mp4",
                    fileUri: video.url
                }
            });
        } else {
            throw new Error("Each video must include either base64 or url");
        }

        return [{ role: "user", parts }];
    }

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
                ?.filter(m => Boolean(m?.text))
                .map(m => ({
                    timestampSeconds: m.timestampSeconds,
                    text: m.text!
                }))
        };
    }
}
