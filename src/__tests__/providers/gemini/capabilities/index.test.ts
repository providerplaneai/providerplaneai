import { describe, expect, it } from "vitest";
import * as caps from "#root/providers/gemini/capabilities/index.js";

describe("gemini capabilities index exports", () => {
    it("re-exports all gemini capability implementations", () => {
        expect(typeof caps.GeminiAudioCapabilityImpl).toBe("function");
        expect(typeof caps.GeminiChatCapabilityImpl).toBe("function");
        expect(typeof caps.GeminiEmbedCapabilityImpl).toBe("function");
        expect(typeof caps.GeminiImageAnalysisCapabilityImpl).toBe("function");
        expect(typeof caps.GeminiImageGenerationCapabilityImpl).toBe("function");
        expect(typeof caps.GeminiModerationCapabilityImpl).toBe("function");
        expect(typeof caps.GeminiVideoGenerationCapabilityImpl).toBe("function");
        expect(typeof caps.GeminiVideoAnalysisCapabilityImpl).toBe("function");
        expect(typeof caps.GeminiVideoExtendCapabilityImpl).toBe("function");
        expect(typeof caps.GeminiVideoDownloadCapabilityImpl).toBe("function");
    });
});
