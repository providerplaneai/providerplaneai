import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

describe("core/provider/index.ts export contract", () => {
    it("contains expected export lines", () => {
        const filePath = path.resolve(process.cwd(), "src/core/provider/index.ts");
        const content = fs.readFileSync(filePath, "utf8");

        expect(content).toContain('export * from "./BaseProvider.js";');
        expect(content).toContain('export * from "./CapabilityMap.js";');
        expect(content).toContain('export * from "./Provider.js";');
        expect(content).toContain('export * from "./CapabilityExecutorRegistry.js";');
        expect(content).toContain('export * from "./capabilities/index.js";');
    });
});
