import { describe, expect, it } from "vitest";
import * as WorkflowModule from "#root/core/workflow/index.js";

describe("core/workflow exports", () => {
    it("exports workflow authoring/runtime surface", () => {
        expect(WorkflowModule.WorkflowBuilder).toBeTypeOf("function");
        expect(WorkflowModule.WorkflowRunner).toBeTypeOf("function");
        expect(WorkflowModule.WorkflowExporter).toBeTypeOf("function");
        expect(WorkflowModule.Pipeline).toBeTypeOf("function");
        expect(WorkflowModule.extractPipelineText).toBeTypeOf("function");
        expect(WorkflowModule.resolvePipelineTemplate).toBeTypeOf("function");
    });
});
