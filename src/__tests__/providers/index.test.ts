import { describe, expect, it } from "vitest";
import * as providers from "#root/providers/index.js";

describe("providers index exports", () => {
    it("re-exports provider classes and capability implementations", () => {
        expect(typeof providers.OpenAIProvider).toBe("function");
        expect(typeof providers.AnthropicProvider).toBe("function");
        expect(typeof providers.GeminiProvider).toBe("function");
        expect(typeof providers.MistralProvider).toBe("function");

        expect(typeof providers.OpenAIChatCapabilityImpl).toBe("function");
        expect(typeof providers.AnthropicModerationCapabilityImpl).toBe("function");
        expect(typeof providers.GeminiImageGenerationCapabilityImpl).toBe("function");
        expect(typeof providers.MistralChatCapabilityImpl).toBe("function");
        expect(typeof providers.MistralAudioTranscriptionCapabilityImpl).toBe("function");
        expect(typeof providers.MistralAudioTextToSpeechCapabilityImpl).toBe("function");
    });
});
