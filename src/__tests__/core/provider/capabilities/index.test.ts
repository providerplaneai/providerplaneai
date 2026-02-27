import { describe, expect, it } from "vitest";

describe("core/provider/capabilities module exports", () => {
    it("index module is importable", async () => {
        const mod = await import("#root/core/provider/capabilities/index.js");
        expect(mod).toBeTypeOf("object");
    });

    it("individual capability modules are importable", async () => {
        const chat = await import("#root/core/provider/capabilities/ChatCapability.js");
        const embed = await import("#root/core/provider/capabilities/EmbedCapability.js");
        const image = await import("#root/core/provider/capabilities/ImageCapability.js");
        const moderation = await import("#root/core/provider/capabilities/ModerationCapability.js");

        expect(chat).toBeTypeOf("object");
        expect(embed).toBeTypeOf("object");
        expect(image).toBeTypeOf("object");
        expect(moderation).toBeTypeOf("object");
    });
});

