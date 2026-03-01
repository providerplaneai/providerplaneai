import {
    AudioTranscriptionCapability,
    AudioTranscriptionStreamCapability,
    AudioTranslationCapability,
    ChatCapability,
    ChatStreamCapability,
    ClientChatRequest,
    ClientAudioTranscriptionRequest,
    ClientAudioTranslationRequest,
    ClientTextToSpeechRequest,
    ClientEmbeddingRequest,
    ClientImageAnalysisRequest,
    ClientImageEditRequest,
    ClientImageGenerationRequest,
    ClientModerationRequest,
    EmbedCapability,
    ImageAnalysisCapability,
    ImageAnalysisStreamCapability,
    ImageEditCapability,
    ImageEditStreamCapability,
    ImageGenerationCapability,
    ImageGenerationStreamCapability,
    ModerationCapability,
    TextToSpeechCapability,
    TextToSpeechStreamCapability,
    NormalizedAudio,
    NormalizedChatMessage,
    NormalizedEmbedding,
    NormalizedImage,
    NormalizedImageAnalysis,
    NormalizedModeration
} from "#root/index.js";

/**
 * Unique string constants for capability keys.
 *
 * Used to register, check, and route capabilities in BaseProvider/AIClient.
 */
export const CapabilityKeys = {
    ChatCapabilityKey: "chat",
    ChatStreamCapabilityKey: "chatStream",
    AudioTranscriptionCapabilityKey: "audioTranscription",
    AudioTranscriptionStreamCapabilityKey: "audioTranscriptionStream",
    AudioTranslationCapabilityKey: "audioTranslation",
    AudioTextToSpeechCapabilityKey: "audioTts",
    AudioTextToSpeechStreamCapabilityKey: "audioTtsStream",
    ImageGenerationCapabilityKey: "imageGeneration",
    ImageGenerationStreamCapabilityKey: "imageGenerationStream",
    ImageEditCapabilityKey: "imageEdit",
    ImageEditStreamCapabilityKey: "imageEditStream",
    ImageAnalysisCapabilityKey: "imageAnalysis",
    ImageAnalysisStreamCapabilityKey: "imageAnalyzeStream",
    EmbedCapabilityKey: "embed",
    ModerationCapabilityKey: "moderation"
} as const;

export type BuiltInCapabilityKey = (typeof CapabilityKeys)[keyof typeof CapabilityKeys];
export type CustomCapabilityKey = string & {};
export type CapabilityKeyType = BuiltInCapabilityKey | CustomCapabilityKey;

/**
 * Mapping from capability keys to their interface implementations.
 *
 * Guarantees:
 * - Providers only expose capabilities they explicitly register
 * - Consumers can safely cast to the capability interface after checking with hasCapability()
 */
export interface CapabilityMap {
    [CapabilityKeys.ChatCapabilityKey]: ChatCapability<ClientChatRequest, NormalizedChatMessage>;
    [CapabilityKeys.ChatStreamCapabilityKey]: ChatStreamCapability<ClientChatRequest, NormalizedChatMessage>;
    [CapabilityKeys.AudioTranscriptionCapabilityKey]: AudioTranscriptionCapability<
        ClientAudioTranscriptionRequest,
        NormalizedAudio[]
    >;
    [CapabilityKeys.AudioTranscriptionStreamCapabilityKey]: AudioTranscriptionStreamCapability<
        ClientAudioTranscriptionRequest,
        NormalizedAudio[]
    >;
    [CapabilityKeys.AudioTranslationCapabilityKey]: AudioTranslationCapability<
        ClientAudioTranslationRequest,
        NormalizedAudio[]
    >;
    [CapabilityKeys.AudioTextToSpeechCapabilityKey]: TextToSpeechCapability<ClientTextToSpeechRequest, NormalizedAudio[]>;
    [CapabilityKeys.AudioTextToSpeechStreamCapabilityKey]: TextToSpeechStreamCapability<
        ClientTextToSpeechRequest,
        NormalizedAudio[]
    >;
    [CapabilityKeys.ImageGenerationCapabilityKey]: ImageGenerationCapability<ClientImageGenerationRequest, NormalizedImage[]>;
    [CapabilityKeys.ImageGenerationStreamCapabilityKey]: ImageGenerationStreamCapability<
        ClientImageGenerationRequest,
        NormalizedImage[]
    >;
    [CapabilityKeys.EmbedCapabilityKey]: EmbedCapability<ClientEmbeddingRequest, NormalizedEmbedding[]>;
    [CapabilityKeys.ModerationCapabilityKey]: ModerationCapability<ClientModerationRequest, NormalizedModeration[]>;
    [CapabilityKeys.ImageAnalysisCapabilityKey]: ImageAnalysisCapability<ClientImageAnalysisRequest, NormalizedImageAnalysis[]>;
    [CapabilityKeys.ImageAnalysisStreamCapabilityKey]: ImageAnalysisStreamCapability<
        ClientImageAnalysisRequest,
        NormalizedImageAnalysis[]
    >;
    [CapabilityKeys.ImageEditCapabilityKey]: ImageEditCapability<ClientImageEditRequest, NormalizedImage[]>;
    [CapabilityKeys.ImageEditStreamCapabilityKey]: ImageEditStreamCapability<ClientImageEditRequest, NormalizedImage[]>;
}
