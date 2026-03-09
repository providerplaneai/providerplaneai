import { describe, expect, it } from "vitest";
import * as WorkflowTypesModule from "#root/core/types/workflow/index.js";

describe("core/types/workflow exports", () => {
    it("exports workflow type module namespace", () => {
        expect(WorkflowTypesModule).toBeDefined();
    });
});
