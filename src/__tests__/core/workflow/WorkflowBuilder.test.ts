import { describe, expect, it, vi } from "vitest";
import { WorkflowBuilder } from "#root/core/workflow/WorkflowBuilder.js";

describe("WorkflowBuilder", () => {
    it("registers nodes and applies default options", () => {
        const run = vi.fn() as any;
        const workflow = new WorkflowBuilder("wf-defaults")
            .node("step-a", run)
            .build();

        expect(workflow.id).toBe("wf-defaults");
        expect(workflow.nodes).toHaveLength(1);
        expect(workflow.nodes[0]?.id).toBe("step-a");
        expect(workflow.nodes[0]?.run).toBe(run);
        expect(workflow.nodes[0]?.dependsOn).toEqual([]);
        expect(workflow.nodes[0]?.retry).toBeUndefined();
    });

    it("throws on duplicate node ids", () => {
        const builder = new WorkflowBuilder("wf-duplicates");
        builder.node("dup", vi.fn() as any);

        expect(() => builder.node("dup", vi.fn() as any)).toThrow("WorkflowBuilder: duplicate node id 'dup'");
    });

    it("supports .after with single and multiple dependencies", () => {
        const workflow = new WorkflowBuilder("wf-after")
            .node("root", vi.fn() as any)
            .after("root", "child-1", vi.fn() as any)
            .after(["root", "child-1"], "child-2", vi.fn() as any, {
                retry: { attempts: 3, backoffMs: 50 }
            })
            .build();

        expect(workflow.nodes.find((n) => n.id === "child-1")?.dependsOn).toEqual(["root"]);
        expect(workflow.nodes.find((n) => n.id === "child-2")?.dependsOn).toEqual(["root", "child-1"]);
        expect(workflow.nodes.find((n) => n.id === "child-2")?.retry).toEqual({ attempts: 3, backoffMs: 50 });
    });

    it("maps condition and timeout options to workflow nodes", () => {
        const condition = vi.fn().mockReturnValue(true);
        const workflow = new WorkflowBuilder("wf-node-options")
            .node("guarded", vi.fn() as any, {
                condition,
                timeoutMs: 1200
            })
            .build();

        expect(workflow.nodes[0]?.condition).toBe(condition);
        expect(workflow.nodes[0]?.timeoutMs).toBe(1200);
    });

    it("stores aggregate function and returns workflow output from aggregate", () => {
        const workflow = new WorkflowBuilder<{ summary: string }>("wf-aggregate")
            .node("a", vi.fn() as any)
            .aggregate((results, state) => ({
                summary: `${String(results.a)}-${String(state.values.extra)}`
            }))
            .build();

        expect(workflow.aggregate).toBeTypeOf("function");
        expect(workflow.aggregate?.({ a: "ok" }, { values: { extra: "state" } })).toEqual({
            summary: "ok-state"
        });
    });

    it("returns a defensive nodes array copy on build", () => {
        const builder = new WorkflowBuilder("wf-copy").node("a", vi.fn() as any);
        const built = builder.build();

        built.nodes.push({
            id: "injected",
            run: vi.fn() as any
        });

        const rebuilt = builder.build();
        expect(rebuilt.nodes.map((n) => n.id)).toEqual(["a"]);
    });
});
