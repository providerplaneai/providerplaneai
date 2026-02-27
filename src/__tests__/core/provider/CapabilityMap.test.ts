import { describe, expect, it } from "vitest";
import { CapabilityKeys } from "#root/index.js";

describe("CapabilityMap module", () => {
    it("exports expected capability key constants", () => {
        expect(CapabilityKeys.ChatCapabilityKey).toBe("chat");
        expect(CapabilityKeys.ChatStreamCapabilityKey).toBe("chatStream");
        expect(CapabilityKeys.ImageGenerationCapabilityKey).toBe("imageGeneration");
        expect(CapabilityKeys.ImageGenerationStreamCapabilityKey).toBe("imageGenerationStream");
        expect(CapabilityKeys.ImageEditCapabilityKey).toBe("imageEdit");
        expect(CapabilityKeys.ImageEditStreamCapabilityKey).toBe("imageEditStream");
        expect(CapabilityKeys.ImageAnalysisCapabilityKey).toBe("imageAnalysis");
        expect(CapabilityKeys.ImageAnalysisStreamCapabilityKey).toBe("imageAnalyzeStream");
        expect(CapabilityKeys.EmbedCapabilityKey).toBe("embed");
        expect(CapabilityKeys.ModerationCapabilityKey).toBe("moderation");
    });

    it("capability key values are unique", () => {
        const values = Object.values(CapabilityKeys);
        const unique = new Set(values);
        expect(unique.size).toBe(values.length);
    });
});

