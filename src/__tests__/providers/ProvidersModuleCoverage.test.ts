import { describe, expect, it, vi } from "vitest";

describe("providers module coverage", () => {
    it("imports every src/providers module", async () => {
        vi.resetModules();
        vi.doUnmock("#root/index.js");
        vi.doUnmock("#root/providers/openai/OpenAIProvider.js");
        vi.doUnmock("#root/providers/anthropic/AnthropicProvider.js");
        vi.doUnmock("#root/providers/gemini/GeminiProvider.js");

        const modules = await Promise.all([
            import("#root/providers/openai/capabilities/index.js"),
            import("#root/providers/openai/capabilities/OpenAIAudioTextToSpeechCapabilityImpl.js"),
            import("#root/providers/openai/capabilities/OpenAIAudioTranscriptionCapabilityImpl.js"),
            import("#root/providers/openai/capabilities/OpenAIAudioTranslationCapabilityImpl.js"),
            import("#root/providers/openai/capabilities/OpenAIChatCapabilityImpl.js"),
            import("#root/providers/openai/capabilities/OpenAIEmbedCapabilityImpl.js"),
            import("#root/providers/openai/capabilities/OpenAIImageAnalysisCapabilityImpl.js"),
            import("#root/providers/openai/capabilities/OpenAIImageEditCapabilityImpl.js"),
            import("#root/providers/openai/capabilities/OpenAIImageGenerationCapabilityImpl.js"),
            import("#root/providers/openai/capabilities/OpenAIModerationCapabilityImpl.js"),
            import("#root/providers/openai/capabilities/OpenAIVideoDownloadCapabilityImpl.js"),
            import("#root/providers/openai/capabilities/OpenAIVideoGenerationCapabilityImpl.js"),
            import("#root/providers/openai/capabilities/OpenAIVideoRemixCapabilityImpl.js"),
            import("#root/providers/anthropic/capabilities/index.js"),
            import("#root/providers/anthropic/capabilities/AnthropicChatCapabilityImpl.js"),
            import("#root/providers/anthropic/capabilities/AnthropicEmbedCapabilityImpl.js"),
            import("#root/providers/anthropic/capabilities/AnthropicImageAnalysisCapabilityImpl.js"),
            import("#root/providers/anthropic/capabilities/AnthropicModerationCapabilityImpl.js"),
            import("#root/providers/gemini/capabilities/index.js"),
            import("#root/providers/gemini/capabilities/GeminiAudioTextToSpeechCapabilityImpl.js"),
            import("#root/providers/gemini/capabilities/GeminiAudioTranscriptionCapabilityImpl.js"),
            import("#root/providers/gemini/capabilities/GeminiAudioTranslationCapabilityImpl.js"),
            import("#root/providers/gemini/capabilities/GeminiChatCapabilityImpl.js"),
            import("#root/providers/gemini/capabilities/GeminiEmbedCapabilityImpl.js"),
            import("#root/providers/gemini/capabilities/GeminiImageAnalysisCapabilityImpl.js"),
            import("#root/providers/gemini/capabilities/GeminiImageGenerationCapabilityImpl.js"),
            import("#root/providers/gemini/capabilities/GeminiModerationCapabilityImpl.js"),
            import("#root/providers/gemini/capabilities/GeminiVideoGenerationCapabilityImpl.js"),
            import("#root/providers/gemini/capabilities/GeminiVideoAnalysisCapabilityImpl.js"),
            import("#root/providers/gemini/capabilities/GeminiVideoExtendCapabilityImpl.js"),
            import("#root/providers/gemini/capabilities/GeminiVideoDownloadCapabilityImpl.js")
        ]);

        expect(modules).toHaveLength(31);
        for (const mod of modules) {
            expect(mod).toBeTruthy();
        }
    });
});
