import { describe, expect, it } from "vitest";
import * as utils from "#root/core/utils/index.js";

describe("core/utils index exports", () => {
    it("re-exports SharedUtils and WithRequestContext symbols", () => {
        expect(typeof utils.ensureDataUri).toBe("function");
        expect(typeof utils.resolveImageToBytes).toBe("function");
        expect(typeof utils.withRequestContext).toBe("function");
        expect(typeof utils.withRequestContextStream).toBe("function");
    });
});
