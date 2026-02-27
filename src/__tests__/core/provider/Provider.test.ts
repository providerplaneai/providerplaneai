import { describe, expect, it } from "vitest";
import { AIProvider } from "#root/index.js";

describe("Provider module", () => {
    it("exports AIProvider constants", () => {
        expect(AIProvider.OpenAI).toBe("openai");
        expect(AIProvider.Anthropic).toBe("anthropic");
        expect(AIProvider.Gemini).toBe("gemini");
    });

    it("AIProvider values are unique", () => {
        const values = Object.values(AIProvider);
        expect(new Set(values).size).toBe(values.length);
    });
});

