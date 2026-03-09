/**
 * @module providers/gemini/capabilities/GeminiAudioTranslationCapabilityImpl.ts
 * @description Provider implementations and capability adapters.
 */
import { GoogleGenAI } from "@google/genai";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import {
    AIProvider,
    AIRequest,
    AIResponse,
    AudioTranslationCapability,
    BaseProvider,
    CapabilityKeys,
    ClientAudioTranslationRequest,
    MultiModalExecutionContext,
    NormalizedChatMessage
} from "#root/index.js";

const DEFAULT_GEMINI_AUDIO_TRANSLATION_MODEL = "gemini-2.5-flash";

/**
 * @public
 * @description Provider capability implementation for GeminiAudioTranslationCapabilityImpl.
 */
export class GeminiAudioTranslationCapabilityImpl implements AudioTranslationCapability<ClientAudioTranslationRequest> {
    constructor(
        private readonly _provider: BaseProvider,
        private readonly _client: GoogleGenAI
    ) {}

    async translateAudio(
        request: AIRequest<ClientAudioTranslationRequest>,
        _ctx: MultiModalExecutionContext,
        signal?: AbortSignal
    ): Promise<AIResponse<NormalizedChatMessage[]>> {
        this._provider.ensureInitialized();

        if (signal?.aborted) {
            throw new Error("Audio translation request aborted before execution");
        }

        const { input, options, context } = request;
        if (!input?.file) {
            throw new Error("Audio translation requires a non-empty 'file' input");
        }

        const merged = this._provider.getMergedOptions(CapabilityKeys.AudioTranslationCapabilityKey, options);
        const model = (merged.model ?? DEFAULT_GEMINI_AUDIO_TRANSLATION_MODEL).replace(/^models\//, "");

        const payload = await this.resolveAudioPayload(input.file, input.mimeType);
        const instruction = this.buildTranslationInstruction(input.targetLanguage, input.prompt, input.responseFormat);

        const response = await this._client.models.generateContent({
            model,
            contents: [
                {
                    role: "user",
                    parts: [
                        { text: instruction },
                        {
                            inlineData: {
                                mimeType: payload.mimeType,
                                data: payload.base64
                            }
                        }
                    ]
                }
            ],
            ...(merged.modelParams ?? {}),
            ...(merged.providerParams ?? {})
        } as any);

        const responseId = response?.responseId ?? context?.requestId ?? crypto.randomUUID();
        const text = typeof response?.text === "string" ? response.text : "";
        const usage = this.extractUsage(response);

        const message: NormalizedChatMessage = {
            id: responseId,
            role: "assistant",
            content: text ? [{ type: "text", text }] : [],
            metadata: {
                ...(context?.metadata ?? {}),
                provider: AIProvider.Gemini,
                model,
                status: "completed",
                requestId: context?.requestId,
                targetLanguage: input.targetLanguage ?? "english",
                ...usage
            }
        };

        return {
            output: [message],
            multimodalArtifacts: { chat: [message] },
            id: responseId,
            rawResponse: response,
            metadata: {
                ...(context?.metadata ?? {}),
                provider: AIProvider.Gemini,
                model,
                status: "completed",
                requestId: context?.requestId,
                targetLanguage: input.targetLanguage ?? "english",
                ...usage
            }
        };
    }

    private extractUsage(response: any): {
        inputTokens?: number;
        outputTokens?: number;
        totalTokens?: number;
    } {
        const usage = response?.usageMetadata;
        if (!usage) {
            return {};
        }
        return {
            inputTokens: usage.promptTokenCount,
            outputTokens: usage.candidatesTokenCount,
            totalTokens: usage.totalTokenCount
        };
    }

    private async resolveAudioPayload(
        source: ClientAudioTranslationRequest["file"],
        mimeHint?: string
    ): Promise<{ base64: string; mimeType: string }> {
        if (this.isBlobLike(source)) {
            const mimeType = mimeHint || (source as any).type || "audio/mpeg";
            const bytes = Buffer.from(await (source as any).arrayBuffer());
            return { base64: bytes.toString("base64"), mimeType };
        }

        if (Buffer.isBuffer(source)) {
            return { base64: source.toString("base64"), mimeType: mimeHint ?? "audio/mpeg" };
        }

        if (source instanceof Uint8Array) {
            return { base64: Buffer.from(source).toString("base64"), mimeType: mimeHint ?? "audio/mpeg" };
        }

        if (source instanceof ArrayBuffer) {
            return { base64: Buffer.from(source).toString("base64"), mimeType: mimeHint ?? "audio/mpeg" };
        }

        if (typeof source === "string") {
            if (source.startsWith("data:")) {
                return this.parseDataUrl(source);
            }

            if (existsSync(source)) {
                const bytes = await readFile(source);
                const mimeType = mimeHint ?? this.inferMimeFromPath(source);
                return { base64: bytes.toString("base64"), mimeType };
            }

            throw new Error("String audio input must be a data URL or local file path");
        }

        if (this.isReadableStreamLike(source)) {
            const bytes = await this.readNodeStreamToBuffer(source as NodeJS.ReadableStream);
            return { base64: bytes.toString("base64"), mimeType: mimeHint ?? "audio/mpeg" };
        }

        throw new Error("Unsupported audio input source for Gemini translation");
    }

    private buildTranslationInstruction(
        targetLanguage?: string,
        prompt?: string,
        responseFormat?: ClientAudioTranslationRequest["responseFormat"]
    ): string {
        const target = targetLanguage?.trim() || "English";
        const formatHint =
            responseFormat && responseFormat !== "json"
                ? `Return the translated output as ${responseFormat}.`
                : "Return only the translated text.";
        const promptHint = prompt?.trim() ? `Additional style guidance: ${prompt.trim()}` : "";

        return [`Translate the provided audio into ${target}.`, formatHint, promptHint].filter(Boolean).join(" ");
    }

    private isBlobLike(value: unknown): boolean {
        return !!value && typeof value === "object" && typeof (value as any).arrayBuffer === "function";
    }

    private isReadableStreamLike(value: unknown): value is NodeJS.ReadableStream {
        return (
            !!value &&
            typeof value === "object" &&
            typeof (value as any).pipe === "function" &&
            typeof (value as any).on === "function"
        );
    }

    private async readNodeStreamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
        const chunks: Buffer[] = [];
        return await new Promise<Buffer>((resolve, reject) => {
            stream.on("data", (chunk: Buffer | Uint8Array | string) => {
                chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk));
            });
            stream.on("end", () => resolve(Buffer.concat(chunks)));
            stream.on("error", reject);
        });
    }

    private parseDataUrl(dataUrl: string): { base64: string; mimeType: string } {
        const commaIndex = dataUrl.indexOf(",");
        if (commaIndex < 0) {
            throw new Error("Invalid data URL");
        }
        const header = dataUrl.slice(0, commaIndex);
        const payload = dataUrl.slice(commaIndex + 1);
        const mimeMatch = /^data:([^;]+)(;base64)?$/i.exec(header);
        const mimeType = mimeMatch?.[1] ?? "application/octet-stream";
        const isBase64 = /;base64$/i.test(header);
        return {
            base64: isBase64 ? payload : Buffer.from(decodeURIComponent(payload), "utf8").toString("base64"),
            mimeType
        };
    }

    private inferMimeFromPath(filePath: string): string {
        const lower = filePath.toLowerCase();
        if (lower.endsWith(".wav")) {
            return "audio/wav";
        }
        if (lower.endsWith(".flac")) {
            return "audio/flac";
        }
        if (lower.endsWith(".m4a")) {
            return "audio/mp4";
        }
        if (lower.endsWith(".ogg") || lower.endsWith(".oga")) {
            return "audio/ogg";
        }
        if (lower.endsWith(".opus")) {
            return "audio/opus";
        }
        if (lower.endsWith(".aac")) {
            return "audio/aac";
        }
        if (lower.endsWith(".webm")) {
            return "audio/webm";
        }
        return "audio/mpeg";
    }
}
