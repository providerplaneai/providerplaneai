import { describe, expect, it } from "vitest";
import * as caps from "#root/providers/openai/capabilities/index.js";

describe("openai capabilities index exports", () => {
    it("re-exports all openai capability implementations", () => {
        expect(typeof caps.OpenAIChatCapabilityImpl).toBe("function");
        expect(typeof caps.OpenAIAudioCapabilityImpl).toBe("function");
        expect(typeof caps.OpenAIEmbedCapabilityImpl).toBe("function");
        expect(typeof caps.OpenAIImageAnalysisCapabilityImpl).toBe("function");
        expect(typeof caps.OpenAIImageGenerationCapabilityImpl).toBe("function");
        expect(typeof caps.OpenAIImageEditCapabilityImpl).toBe("function");
        expect(typeof caps.OpenAIModerationCapabilityImpl).toBe("function");
        expect(typeof caps.OpenAIVideoDownloadCapabilityImpl).toBe("function");
        expect(typeof caps.OpenAIVideoGenerationCapabilityImpl).toBe("function");
        expect(typeof caps.OpenAIVideoRemixCapabilityImpl).toBe("function");
    });
});
