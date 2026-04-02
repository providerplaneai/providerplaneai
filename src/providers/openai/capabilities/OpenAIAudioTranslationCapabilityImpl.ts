/**
 * @module providers/openai/capabilities/OpenAIAudioTranslationCapabilityImpl.ts
 * @description OpenAI audio translation capability adapter.
 */
import OpenAI from "openai";
import {
    AIProvider,
    AIRequest,
    AIResponse,
    AudioTranslationCapability,
    BaseProvider,
    CapabilityKeys,
    ClientAudioTranslationRequest,
    MultiModalExecutionContext,
    NormalizedChatMessage,
    buildMetadata,
    toOpenAIUploadableFile
} from "#root/index.js";

const DEFAULT_OPENAI_AUDIO_TRANSLATION_MODEL = "whisper-1";
const ENGLISH_TARGET_ALIASES = new Set(["en", "eng", "english", "en-us", "en-gb"]);

/**
 * OpenAI audio translation capability implementation.
 *
 * Uses OpenAI's dedicated audio translations endpoint, which always returns English output.
 *
 * @public
 */
export class OpenAIAudioTranslationCapabilityImpl implements AudioTranslationCapability<ClientAudioTranslationRequest> {
    /**
     * Creates a new OpenAI audio translation capability adapter.
     *
     * @param {BaseProvider} provider Owning provider instance used for initialization checks and merged config access.
     * @param {OpenAI} client Initialized OpenAI SDK client.
     */
    constructor(
        private readonly provider: BaseProvider,
        private readonly client: OpenAI
    ) {}

    /**
     * Translates spoken audio into English text.
     *
     * @param {AIRequest<ClientAudioTranslationRequest>} request Unified translation request envelope.
     * @param {MultiModalExecutionContext} _ctx Optional multimodal execution context. Unused directly in this adapter.
     * @param {AbortSignal} [signal] Optional cancellation signal.
     * @returns {Promise<AIResponse<NormalizedChatMessage[]>>} Provider-normalized translated chat message artifacts.
     * @throws {Error} If input file is missing, request is aborted, or target language is unsupported.
     */
    async translateAudio(
        request: AIRequest<ClientAudioTranslationRequest>,
        _ctx: MultiModalExecutionContext,
        signal?: AbortSignal
    ): Promise<AIResponse<NormalizedChatMessage[]>> {
        this.provider.ensureInitialized();

        if (signal?.aborted) {
            throw new Error("Audio translation request aborted before execution");
        }

        const { input, options, context } = request;
        if (!input?.file) {
            throw new Error("Audio translation requires a non-empty 'file' input");
        }

        // OpenAI audio translation endpoint translates to English.
        if (input.targetLanguage && !this.isEnglishTarget(input.targetLanguage)) {
            throw new Error("OpenAI audio translation supports English output only");
        }

        const merged = this.provider.getMergedOptions(CapabilityKeys.AudioTranslationCapabilityKey, options);
        const model = merged.model ?? DEFAULT_OPENAI_AUDIO_TRANSLATION_MODEL;

        // Convert caller-provided source variants (buffer/blob/path/data URL/stream) into OpenAI upload format.
        const uploadFile = await toOpenAIUploadableFile(
            input.file,
            input.filename,
            input.mimeType,
            "audio-input",
            "String audio input must be a data URL or local file path"
        );
        const response = await this.client.audio.translations.create(
            {
                file: uploadFile as any,
                model: model as any,
                ...(input.prompt !== undefined ? { prompt: input.prompt } : {}),
                ...(input.responseFormat !== undefined ? { response_format: input.responseFormat as any } : {}),
                ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
                ...(merged.modelParams ?? {}),
                ...(merged.providerParams ?? {})
            },
            { signal }
        );

        const responseId = (response as any)?.id ?? context?.requestId ?? crypto.randomUUID();
        const text = this.extractTranslationText(response);

        const message: NormalizedChatMessage = {
            id: responseId,
            role: "assistant",
            content: text ? [{ type: "text", text }] : [],
            metadata: buildMetadata(context?.metadata, {
                provider: AIProvider.OpenAI,
                model,
                status: "completed",
                requestId: context?.requestId
            })
        };

        return {
            output: [message],
            multimodalArtifacts: { chat: [message] },
            id: responseId,
            rawResponse: response,
            metadata: buildMetadata(context?.metadata, {
                provider: AIProvider.OpenAI,
                model,
                status: "completed",
                requestId: context?.requestId
            })
        };
    }

    /**
     * Checks whether a target language hint maps to English.
     *
     * @param {string} value User-provided target language hint.
     * @returns {boolean} `true` when the hint maps to an English variant.
     */
    private isEnglishTarget(value: string): boolean {
        return ENGLISH_TARGET_ALIASES.has(value.trim().toLowerCase());
    }

    /**
     * Extracts translated text from OpenAI translation response variants.
     *
     * @param {unknown} response Raw response payload from the OpenAI SDK.
     * @returns {string} Extracted translated text, or an empty string when unavailable.
     */
    private extractTranslationText(response: unknown): string {
        if (typeof response === "string") {
            return response;
        }
        const asAny = response as any;
        if (typeof asAny?.text === "string") {
            return asAny.text;
        }
        return "";
    }
}
