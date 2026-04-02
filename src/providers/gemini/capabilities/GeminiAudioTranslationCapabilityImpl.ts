/**
 * @module providers/gemini/capabilities/GeminiAudioTranslationCapabilityImpl.ts
 * @description Gemini audio translation capability adapter.
 */
import { GoogleGenAI } from "@google/genai";
import {
    AIProvider,
    AIRequest,
    AIResponse,
    AudioTranslationCapability,
    BaseProvider,
    CapabilityKeys,
    ClientAudioTranslationRequest,
    inferMimeTypeFromFilename,
    MultiModalExecutionContext,
    NormalizedChatMessage,
    resolveBinarySourceToBase64,
    buildMetadata
} from "#root/index.js";

const DEFAULT_GEMINI_AUDIO_TRANSLATION_MODEL = "gemini-2.5-flash";

/**
 * Adapts Gemini audio translation responses into ProviderPlaneAI's normalized chat artifact surface.
 *
 * Gemini does not expose a dedicated translation endpoint, so this adapter sends
 * audio plus an instruction prompt through `models.generateContent`.
 *
 * @public
 */
export class GeminiAudioTranslationCapabilityImpl implements AudioTranslationCapability<ClientAudioTranslationRequest> {
    /**
     * Creates a new Gemini audio translation capability adapter.
     *
     * @param {BaseProvider} _provider Owning provider instance used for initialization checks and merged config access.
     * @param {GoogleGenAI} _client Initialized Google GenAI SDK client.
     */
    constructor(
        private readonly _provider: BaseProvider,
        private readonly _client: GoogleGenAI
    ) {}

    /**
     * Executes a Gemini audio translation request.
     *
     * @param {AIRequest<ClientAudioTranslationRequest>} request Unified translation request envelope.
     * @param {MultiModalExecutionContext} _ctx Optional multimodal execution context. Unused directly in this adapter.
     * @param {AbortSignal} [signal] Optional cancellation signal.
     * @returns {Promise<AIResponse<NormalizedChatMessage[]>>} Provider-normalized translated chat message artifacts.
     * @throws {Error} When input is invalid or the request is aborted before execution.
     */
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
            metadata: buildMetadata(context?.metadata, {
                provider: AIProvider.Gemini,
                model,
                status: "completed",
                requestId: context?.requestId,
                targetLanguage: input.targetLanguage ?? "english",
                ...usage
            })
        };

        return {
            output: [message],
            multimodalArtifacts: { chat: [message] },
            id: responseId,
            rawResponse: response,
            metadata: buildMetadata(context?.metadata, {
                provider: AIProvider.Gemini,
                model,
                status: "completed",
                requestId: context?.requestId,
                targetLanguage: input.targetLanguage ?? "english",
                ...usage
            })
        };
    }

    /**
     * Extracts Gemini token usage counters when available.
     *
     * @param {any} response Raw Gemini SDK response.
     * @returns {{ inputTokens?: number; outputTokens?: number; totalTokens?: number; }} Normalized usage counters.
     */
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

    /**
     * Resolves the caller's audio source into Gemini inline audio payload fields.
     *
     * @param {ClientAudioTranslationRequest["file"]} source Audio source provided by the caller.
     * @param {string | undefined} mimeHint Optional MIME type hint.
     * @returns {Promise<{ base64: string; mimeType: string }>} Base64 audio payload plus resolved MIME type.
     */
    private async resolveAudioPayload(
        source: ClientAudioTranslationRequest["file"],
        mimeHint?: string
    ): Promise<{ base64: string; mimeType: string }> {
        const resolved = await resolveBinarySourceToBase64(source, {
            mimeTypeHint: mimeHint,
            defaultMimeType: "audio/mpeg",
            defaultFileName: "audio-input",
            inferMimeTypeFromPath: (filePath) => this.inferMimeFromPath(filePath),
            invalidStringMessage: "String audio input must be a data URL or local file path",
            unsupportedSourceMessage: "Unsupported audio input source for Gemini translation"
        });
        return { base64: resolved.base64, mimeType: resolved.mimeType };
    }

    /**
     * Builds the translation instruction sent alongside the inline audio payload.
     *
     * @param {string | undefined} targetLanguage Optional target language hint.
     * @param {string | undefined} prompt Optional caller-supplied style guidance.
     * @param {ClientAudioTranslationRequest["responseFormat"] | undefined} responseFormat Desired response format hint.
     * @returns {string} Consolidated instruction text for Gemini.
     */
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

    /**
     * Infers a fallback audio MIME type from a local file path.
     *
     * @param {string} filePath Local file path.
     * @returns {string} Resolved audio MIME type.
     */
    private inferMimeFromPath(filePath: string): string {
        return inferMimeTypeFromFilename(filePath, "audio/mpeg")!;
    }
}
