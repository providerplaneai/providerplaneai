import {
    ChatCapability,
    ChatStreamCapability,
    ClientChatRequest,
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
    ModerationResult,
    NormalizedImage,
    NormalizedImageAnalysis
} from "#root/index.js";

/**
 * Unique string constants for capability keys.
 *
 * Used to register, check, and route capabilities in BaseProvider/AIClient.
 */
export const CapabilityKeys = {
    ChatCapabilityKey: "chat",
    ChatStreamCapabilityKey: "chatStream",
    ImageGenerationCapabilityKey: "imageGeneration",
    ImageGenerationStreamCapabilityKey: "imageGenerateStream",
    ImageEditCapabilityKey: "imageEdit",
    ImageEditStreamCapabilityKey: "imageEditStream",
    ImageAnalysisCapabilityKey: "imageAnalyze",
    ImageAnalysisStreamCapabilityKey: "imageAnalyzeStream",
    EmbedCapabilityKey: "embed",
    ModerationCapabilityKey: "moderation"
} as const;

export type CapabilityKeyType = (typeof CapabilityKeys)[keyof typeof CapabilityKeys];

/**
 * Mapping from capability keys to their interface implementations.
 *
 * Guarantees:
 * - Providers only expose capabilities they explicitly register
 * - Consumers can safely cast to the capability interface after checking with hasCapability()
 */
export interface CapabilityMap {
    [CapabilityKeys.ChatCapabilityKey]: ChatCapability<ClientChatRequest, string>;
    [CapabilityKeys.ChatStreamCapabilityKey]: ChatStreamCapability<ClientChatRequest, string>;
    [CapabilityKeys.ImageGenerationCapabilityKey]: ImageGenerationCapability<ClientImageGenerationRequest, NormalizedImage[]>;
    [CapabilityKeys.ImageGenerationStreamCapabilityKey]: ImageGenerationStreamCapability<
        ClientImageGenerationRequest,
        NormalizedImage[]
    >;
    [CapabilityKeys.EmbedCapabilityKey]: EmbedCapability<ClientEmbeddingRequest, number[] | number[][]>;
    [CapabilityKeys.ModerationCapabilityKey]: ModerationCapability<
        ClientModerationRequest,
        ModerationResult | ModerationResult[]
    >;
    [CapabilityKeys.ImageAnalysisCapabilityKey]: ImageAnalysisCapability<ClientImageAnalysisRequest, NormalizedImageAnalysis[]>;
    [CapabilityKeys.ImageAnalysisStreamCapabilityKey]: ImageAnalysisStreamCapability<
        ClientImageAnalysisRequest,
        NormalizedImageAnalysis[]
    >;
    [CapabilityKeys.ImageEditCapabilityKey]: ImageEditCapability<ClientImageEditRequest, NormalizedImage[]>;
    [CapabilityKeys.ImageEditStreamCapabilityKey]: ImageEditStreamCapability<ClientImageEditRequest, NormalizedImage[]>;
}
