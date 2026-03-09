/**
 * @module core/provider/CapabilityMap.ts
 * @description Capability key registry and compile-time mapping from keys to capability interfaces.
 */
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
    ClientVideoAnalysisRequest,
    ClientVideoDownloadRequest,
    ClientVideoExtendRequest,
    ClientVideoGenerationRequest,
    ClientVideoRemixRequest,
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
    VideoGenerationCapability,
    VideoDownloadCapability,
    VideoExtendCapability,
    VideoAnalysisCapability,
    VideoRemixCapability,
    NormalizedAudio,
    NormalizedChatMessage,
    NormalizedEmbedding,
    NormalizedImage,
    NormalizedImageAnalysis,
    NormalizedModeration,
    ProviderCapability,
    NormalizedVideo,
    NormalizedVideoAnalysis
} from "#root/index.js";

/**
 * @public
 * @description Canonical capability keys used for registration, routing, and job execution.
 */
export const CapabilityKeys = {
    ApprovalGateCapabilityKey: "approvalGate",
    SaveFileCapabilityKey: "saveFile",
    ChatCapabilityKey: "chat",
    ChatStreamCapabilityKey: "chatStream",
    AudioTranscriptionCapabilityKey: "audioTranscription",
    AudioTranscriptionStreamCapabilityKey: "audioTranscriptionStream",
    AudioTranslationCapabilityKey: "audioTranslation",
    AudioTextToSpeechCapabilityKey: "audioTts",
    AudioTextToSpeechStreamCapabilityKey: "audioTtsStream",
    VideoGenerationCapabilityKey: "videoGeneration",
    VideoDownloadCapabilityKey: "videoDownload",
    VideoExtendCapabilityKey: "videoExtend",
    VideoAnalysisCapabilityKey: "videoAnalysis",
    VideoRemixCapabilityKey: "videoRemix",
    ImageGenerationCapabilityKey: "imageGeneration",
    ImageGenerationStreamCapabilityKey: "imageGenerationStream",
    ImageEditCapabilityKey: "imageEdit",
    ImageEditStreamCapabilityKey: "imageEditStream",
    ImageAnalysisCapabilityKey: "imageAnalysis",
    ImageAnalysisStreamCapabilityKey: "imageAnalyzeStream",
    EmbedCapabilityKey: "embed",
    ModerationCapabilityKey: "moderation"
} as const;

/**
 * @public
 * @description Union of built-in capability key string literals.
 */
export type BuiltInCapabilityKey = (typeof CapabilityKeys)[keyof typeof CapabilityKeys];
/**
 * @public
 * @description Branded string type for user-defined custom capability keys.
 */
export type CustomCapabilityKey = string & {};
/**
 * @public
 * @description Any capability key accepted by the system (built-in or custom).
 */
export type CapabilityKeyType = BuiltInCapabilityKey | CustomCapabilityKey;

/**
 * @public
 * @description Compile-time map from capability keys to capability interface signatures.
 */
export interface CapabilityMap {
    [CapabilityKeys.ApprovalGateCapabilityKey]: ProviderCapability;
    [CapabilityKeys.SaveFileCapabilityKey]: ProviderCapability;
    [CapabilityKeys.ChatCapabilityKey]: ChatCapability<ClientChatRequest, NormalizedChatMessage>;
    [CapabilityKeys.ChatStreamCapabilityKey]: ChatStreamCapability<ClientChatRequest, NormalizedChatMessage>;
    [CapabilityKeys.AudioTranscriptionCapabilityKey]: AudioTranscriptionCapability<
        ClientAudioTranscriptionRequest,
        NormalizedChatMessage[]
    >;
    [CapabilityKeys.AudioTranscriptionStreamCapabilityKey]: AudioTranscriptionStreamCapability<
        ClientAudioTranscriptionRequest,
        NormalizedChatMessage[]
    >;
    [CapabilityKeys.AudioTranslationCapabilityKey]: AudioTranslationCapability<
        ClientAudioTranslationRequest,
        NormalizedChatMessage[]
    >;
    [CapabilityKeys.AudioTextToSpeechCapabilityKey]: TextToSpeechCapability<ClientTextToSpeechRequest, NormalizedAudio[]>;
    [CapabilityKeys.AudioTextToSpeechStreamCapabilityKey]: TextToSpeechStreamCapability<
        ClientTextToSpeechRequest,
        NormalizedAudio[]
    >;
    [CapabilityKeys.VideoGenerationCapabilityKey]: VideoGenerationCapability<ClientVideoGenerationRequest, NormalizedVideo[]>;
    [CapabilityKeys.VideoDownloadCapabilityKey]: VideoDownloadCapability<ClientVideoDownloadRequest, NormalizedVideo[]>;
    [CapabilityKeys.VideoExtendCapabilityKey]: VideoExtendCapability<ClientVideoExtendRequest, NormalizedVideo[]>;
    [CapabilityKeys.VideoAnalysisCapabilityKey]: VideoAnalysisCapability<ClientVideoAnalysisRequest, NormalizedVideoAnalysis[]>;
    [CapabilityKeys.VideoRemixCapabilityKey]: VideoRemixCapability<ClientVideoRemixRequest, NormalizedVideo[]>;
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
