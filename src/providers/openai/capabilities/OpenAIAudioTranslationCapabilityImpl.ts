import OpenAI from "openai";
import {
    AIRequest,
    AIResponse,
    AudioTranslationCapability,
    BaseProvider,
    CapabilityKeys,
    ClientAudioTranslationRequest,
    extractAudioMimeInfo,
    extractResponseIdByKeys,
    MultiModalExecutionContext,
    NormalizedAudio,
    resolveAudioInputMimeType
} from "#root/index.js";
import {
    buildMetadata,
    extractSegments,
    extractWords,
    inferDurationSeconds
} from "./shared/OpenAIAudioUtils.js";

const DEFAULT_TRANSLATION_MODEL = "whisper-1";

/**
 * OpenAI audio translation adapter.
 */
export class OpenAIAudioTranslationCapabilityImpl implements 
    AudioTranslationCapability<ClientAudioTranslationRequest, NormalizedAudio[]>
{
    constructor(
        private readonly provider: BaseProvider,
        private readonly client: OpenAI
    ) {}

    async translateAudio(
        request: AIRequest<ClientAudioTranslationRequest>,
        _executionContext?: MultiModalExecutionContext,
        signal?: AbortSignal
    ): Promise<AIResponse<NormalizedAudio[]>> {
        this.provider.ensureInitialized();

        const { input, options, context } = request;
        if (!input?.file) {
            throw new Error("Audio translation requires an input file");
        }
        if (
            input.targetLanguage &&
            input.targetLanguage.toLowerCase() !== "english" &&
            input.targetLanguage.toLowerCase() !== "en"
        ) {
            throw new Error("OpenAI audio translation currently supports English as the target language");
        }

        const merged = this.provider.getMergedOptions(CapabilityKeys.AudioTranslationCapabilityKey, options);
        const inputMimeType = resolveAudioInputMimeType(input.file, input.mimeType, input.filename);

        const response = await this.client.audio.translations.create(
            {
                file: input.file as any,
                model: merged.model ?? DEFAULT_TRANSLATION_MODEL,
                prompt: input.prompt,
                temperature: input.temperature,
                response_format: (input.responseFormat as any) ?? "json",
                ...(merged.modelParams ?? {}),
                ...(merged.providerParams ?? {})
            },
            { signal }
        );

        const transcript = typeof response === "string" ? response : (response as any).text;
        const inputAudioInfo = extractAudioMimeInfo(inputMimeType);
        const artifactId = extractResponseIdByKeys(response, ["id"]) ?? context?.requestId ?? crypto.randomUUID();
        const output = [
            {
                id: artifactId,
                kind: "translation",
                mimeType: inputMimeType,
                transcript,
                language: (response as any)?.language ?? "en",
                durationSeconds:
                    (response as any)?.duration ??
                    inferDurationSeconds(extractSegments(response), extractWords(response)),
                segments: extractSegments(response),
                words: extractWords(response),
                sampleRateHz: inputAudioInfo.sampleRateHz,
                channels: inputAudioInfo.channels,
                bitrate: inputAudioInfo.bitrate
            } satisfies NormalizedAudio
        ];

        return {
            output,
            multimodalArtifacts: { audio: output },
            rawResponse: response,
            id: extractResponseIdByKeys(response, ["id"]) ?? context?.requestId ?? crypto.randomUUID(),
            metadata: buildMetadata(context, merged.model, "completed", context?.requestId, {
                audioRetryCount: 0,
                audioFallbackUsed: false,
                audioSource: "openai-translations"
            })
        };
    }
}
