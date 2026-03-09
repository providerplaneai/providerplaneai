import { describe, expect, it } from "vitest";
import * as WorkflowModule from "#root/core/workflow/index.js";

describe("core/workflow exports", () => {
    it("exports WorkflowBuilder and WorkflowRunner", () => {
        expect(WorkflowModule.WorkflowBuilder).toBeTypeOf("function");
        expect(WorkflowModule.WorkflowRunner).toBeTypeOf("function");
    });
});
