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
            import("#root/providers/openai/capabilities/OpenAIAudioCapabilityImpl.js"),
            import("#root/providers/openai/capabilities/OpenAIChatCapabilityImpl.js"),
            import("#root/providers/openai/capabilities/OpenAIEmbedCapabilityImpl.js"),
            import("#root/providers/openai/capabilities/OpenAIImageAnalysisCapabilityImpl.js"),
            import("#root/providers/openai/capabilities/OpenAIImageEditCapabilityImpl.js"),
            import("#root/providers/openai/capabilities/OpenAIImageGenerationCapabilityImpl.js"),
            import("#root/providers/openai/capabilities/OpenAIModerationCapabilityImpl.js"),
            import("#root/providers/anthropic/capabilities/index.js"),
            import("#root/providers/anthropic/capabilities/AnthropicChatCapabilityImpl.js"),
            import("#root/providers/anthropic/capabilities/AnthropicEmbedCapabilityImpl.js"),
            import("#root/providers/anthropic/capabilities/AnthropicImageAnalysisCapabilityImpl.js"),
            import("#root/providers/anthropic/capabilities/AnthropicModerationCapabilityImpl.js"),
            import("#root/providers/gemini/capabilities/index.js"),
            import("#root/providers/gemini/capabilities/GeminiAudioCapabilityImpl.js"),
            import("#root/providers/gemini/capabilities/GeminiChatCapabilityImpl.js"),
            import("#root/providers/gemini/capabilities/GeminiEmbedCapabilityImpl.js"),
            import("#root/providers/gemini/capabilities/GeminiImageAnalysisCapabilityImpl.js"),
            import("#root/providers/gemini/capabilities/GeminiImageGenerationCapabilityImpl.js"),
            import("#root/providers/gemini/capabilities/GeminiModerationCapabilityImpl.js")
        ]);

        expect(modules).toHaveLength(20);
        for (const mod of modules) {
            expect(mod).toBeTruthy();
        }
    });
});
