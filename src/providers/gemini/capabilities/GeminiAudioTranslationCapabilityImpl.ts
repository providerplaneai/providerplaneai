import { GoogleGenAI } from "@google/genai";
import {
    AIRequest,
    AIResponse,
    AudioTranslationCapability,
    BaseProvider,
    CapabilityKeys,
    ClientAudioTranslationRequest,
    createAudioArtifact,
    extractAudioMimeInfo,
    extractResponseIdByKeys,
    MultiModalExecutionContext,
    NormalizedAudio
} from "#root/index.js";
import {
    buildAudioContents,
    buildMetadata,
    extractGeminiText,
    extractUsage,
    normalizeAudioInput,
    stripModelPrefix
} from "./shared/GeminiAudioUtils.js";


const DEFAULT_TRANSLATION_TARGET_LANGUAGE = "en";
const DEFAULT_TRANSLATION_MODEL = "gemini-2.5-flash";

/**
 * Gemini audio translation adapter.
 */
export class GeminiAudioTranslationCapabilityImpl implements 
    AudioTranslationCapability<ClientAudioTranslationRequest, NormalizedAudio[]> {

    constructor(
        private readonly provider: BaseProvider,
        private readonly client: GoogleGenAI
    ) { }

    /**
     * Non-streaming audio translation.
     *
     * Gemini translation here is prompt-driven (audio input + translated text output),
     * unlike OpenAI's dedicated audio translation endpoint contract.
     *
     * @param request Unified audio translation request
     * @param _executionContext Optional execution context (unused)
     * @param signal Optional abort signal
     * @returns Normalized translated transcript artifact response
     * @throws Error if input file is missing or request is aborted
     */
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

        const targetLanguage = input.targetLanguage ?? DEFAULT_TRANSLATION_TARGET_LANGUAGE;
        const merged = this.provider.getMergedOptions(CapabilityKeys.AudioTranslationCapabilityKey, options);

        const audio = await normalizeAudioInput(input.file, input.mimeType, input.filename);
        const response = await this.client.models.generateContent({
            model: stripModelPrefix(merged.model ?? DEFAULT_TRANSLATION_MODEL),
            contents: buildAudioContents(
                input.prompt
                    ? `${input.prompt}\n\nTranslate the spoken audio into ${targetLanguage}. Return only the translated text.`
                    : `Translate the spoken audio into ${targetLanguage}. Return only the translated text.`,
                audio
            ),
            config: {
                ...(merged.modelParams ?? {})
            },
            ...(merged.providerParams ?? {})
        });

        if (signal?.aborted) {
            throw new Error("Request aborted");
        }

        const transcript = extractGeminiText(response);
        const inputAudioInfo = extractAudioMimeInfo(audio.mimeType);
        const artifactId = extractResponseIdByKeys(response, ["responseId", "id"]) ?? context?.requestId ?? crypto.randomUUID();
        const output: NormalizedAudio[] = [
            createAudioArtifact({
                id: artifactId,
                kind: "translation",
                mimeType: audio.mimeType,
                transcript,
                language: targetLanguage,
                sampleRateHz: inputAudioInfo.sampleRateHz,
                channels: inputAudioInfo.channels,
                bitrate: inputAudioInfo.bitrate
            })
        ];

        return {
            output,
            multimodalArtifacts: { audio: output },
            rawResponse: response,
            id: extractResponseIdByKeys(response, ["responseId", "id"]) ?? context?.requestId ?? crypto.randomUUID(),
            metadata: buildMetadata(context, merged.model, "completed", extractUsage(response))
        };
    }
}
