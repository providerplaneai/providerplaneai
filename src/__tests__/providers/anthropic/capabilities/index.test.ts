import { describe, expect, it } from "vitest";
import * as caps from "#root/providers/anthropic/capabilities/index.js";

describe("anthropic capabilities index exports", () => {
    it("re-exports all anthropic capability implementations", () => {
        expect(typeof caps.AnthropicChatCapabilityImpl).toBe("function");
        expect(typeof caps.AnthropicEmbedCapabilityImpl).toBe("function");
        expect(typeof caps.AnthropicModerationCapabilityImpl).toBe("function");
        expect(typeof caps.AnthropicImageAnalysisCapabilityImpl).toBe("function");
    });
});
