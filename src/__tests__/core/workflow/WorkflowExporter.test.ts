import path from "node:path";
import { tmpdir } from "node:os";
import { readFile, rm } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { WorkflowExporter } from "#root/core/workflow/WorkflowExporter.js";

describe("WorkflowExporter", () => {
    it("exports Mermaid using safe internal node ids and escaped labels", () => {
        const workflow = {
            id: "wf-mermaid",
            nodes: [
                { id: 'start-node', run: (() => undefined) as any },
                { id: 'step "quoted"', dependsOn: ["start-node"], run: (() => undefined) as any }
            ]
        } as any;

        const out = WorkflowExporter.workflowAsMermaid(workflow);

        expect(out).toContain('n0["start-node"]');
        expect(out).toContain('n1["step \\"quoted\\""]');
        expect(out).toContain("n0 --> n1");
        expect(out).not.toContain("start-node --> step");
    });

    it("exports Mermaid with explicit labels for dependency-only nodes", () => {
        const workflow = {
            id: "wf-mermaid-dep-only",
            nodes: [
                { id: "b", dependsOn: ["a"], run: (() => undefined) as any }
            ]
        } as any;

        const out = WorkflowExporter.workflowAsMermaid(workflow);
        expect(out).toContain('n0["b"]');
        expect(out).toContain('n1["a"]');
        expect(out).toContain("n1 --> n0");
    });

    it("escapes Mermaid labels for control chars and square brackets", () => {
        const workflow = {
            id: "wf-mermaid-escape",
            nodes: [
                { id: "line1\nline2[tab]\t\"q\"", run: (() => undefined) as any }
            ]
        } as any;

        const out = WorkflowExporter.workflowAsMermaid(workflow);
        expect(out).toContain("line1\\nline2&#91;tab&#93;\\t\\\"q\\\"");
    });

    it("exports DOT with quoted/escaped node ids and labels", () => {
        const workflow = {
            id: "wf-dot",
            nodes: [
                { id: "root node", run: (() => undefined) as any },
                { id: 'child-node"', dependsOn: ["root node"], run: (() => undefined) as any }
            ]
        } as any;

        const out = WorkflowExporter.workflowAsDOT(workflow);

        expect(out).toContain('"root node" [label="root node"];');
        expect(out).toContain('"child-node\\"" [label="child-node\\""];');
        expect(out).toContain('"root node" -> "child-node\\""');
    });

    it("exports json and d3 formats with dependency edges", () => {
        const workflow = {
            id: "wf-struct",
            nodes: [
                { id: "a", run: (() => undefined) as any },
                { id: "b", dependsOn: ["a"], run: (() => undefined) as any }
            ]
        } as any;

        const json = WorkflowExporter.export(workflow, "json") as any;
        const d3 = WorkflowExporter.export(workflow, "d3") as any;

        expect(json.id).toBe("wf-struct");
        expect(json.edges).toEqual([{ from: "a", to: "b" }]);
        expect(d3.edges).toEqual([{ from: "a", to: "b" }]);
        expect(d3.nodes).toEqual([{ id: "a" }, { id: "b" }]);
    });

    it("includes dependency-only nodes in DOT and D3 exports", () => {
        const workflow = {
            id: "wf-dep-only",
            nodes: [
                { id: "b", dependsOn: ["a"], run: (() => undefined) as any }
            ]
        } as any;

        const dot = WorkflowExporter.workflowAsDOT(workflow);
        const d3 = WorkflowExporter.workflowAsD3(workflow);

        expect(dot).toContain('"a" [label="a"];');
        expect(dot).toContain('"b" [label="b"];');
        expect(dot).toContain('"a" -> "b";');
        expect(d3.nodes).toEqual([{ id: "b" }, { id: "a" }]);

        const json = WorkflowExporter.workflowAsJSON(workflow);
        expect(json.nodes).toEqual([
            { id: "b", dependsOn: ["a"] },
            { id: "a", dependsOn: [] }
        ]);
    });

    it("deduplicates duplicate dependency edges across exporters", () => {
        const workflow = {
            id: "wf-dedup",
            nodes: [
                { id: "b", dependsOn: ["a", "a"], run: (() => undefined) as any }
            ]
        } as any;

        const mermaid = WorkflowExporter.workflowAsMermaid(workflow);
        const dot = WorkflowExporter.workflowAsDOT(workflow);
        const json = WorkflowExporter.workflowAsJSON(workflow);
        const d3 = WorkflowExporter.workflowAsD3(workflow);

        expect((mermaid.match(/-->/g) ?? []).length).toBe(1);
        expect((dot.match(/->/g) ?? []).length).toBe(1);
        expect(json.edges).toEqual([{ from: "a", to: "b" }]);
        expect(json.nodes[0]?.dependsOn).toEqual(["a"]);
        expect(d3.edges).toEqual([{ from: "a", to: "b" }]);
    });

    it("writes exports to file asynchronously", async () => {
        const workflow = {
            id: "wf-file",
            nodes: [{ id: "a", run: (() => undefined) as any }]
        } as any;

        const textPath = path.join(tmpdir(), `wf-export-${Date.now()}-mmd.txt`);
        const jsonPath = path.join(tmpdir(), `wf-export-${Date.now()}-json.txt`);

        try {
            await WorkflowExporter.exportToFile(workflow, "mermaid", textPath);
            await WorkflowExporter.exportToFile(workflow, "json", jsonPath);

            const mermaid = await readFile(textPath, "utf-8");
            const json = await readFile(jsonPath, "utf-8");

            expect(mermaid).toContain("graph TD");
            expect(JSON.parse(json).id).toBe("wf-file");
        } finally {
            await rm(textPath, { force: true });
            await rm(jsonPath, { force: true });
        }
    });

    it("writes DOT and D3 exports to file", async () => {
        const workflow = {
            id: "wf-file-dot-d3",
            nodes: [{ id: "a", run: (() => undefined) as any }]
        } as any;

        const dotPath = path.join(tmpdir(), `wf-export-${Date.now()}-dot.txt`);
        const d3Path = path.join(tmpdir(), `wf-export-${Date.now()}-d3.txt`);

        try {
            await WorkflowExporter.exportToFile(workflow, "dot", dotPath);
            await WorkflowExporter.exportToFile(workflow, "d3", d3Path);

            const dot = await readFile(dotPath, "utf-8");
            const d3 = await readFile(d3Path, "utf-8");

            expect(dot).toContain("digraph Workflow {");
            expect(JSON.parse(d3).nodes).toEqual([{ id: "a" }]);
        } finally {
            await rm(dotPath, { force: true });
            await rm(d3Path, { force: true });
        }
    });

    it("creates parent directories when exporting to file", async () => {
        const workflow = {
            id: "wf-file-nested",
            nodes: [{ id: "a", run: (() => undefined) as any }]
        } as any;

        const baseDir = path.join(tmpdir(), `wf-export-nested-${Date.now()}`);
        const nestedDir = path.join(baseDir, "a", "b");
        const nestedFile = path.join(nestedDir, "workflow.json");

        try {
            await WorkflowExporter.exportToFile(workflow, "json", nestedFile);
            const content = await readFile(nestedFile, "utf-8");
            expect(JSON.parse(content).id).toBe("wf-file-nested");
        } finally {
            await rm(baseDir, { recursive: true, force: true }).catch(() => undefined);
        }
    });

    it("respects autoCreateDir=false by failing when parent dir is missing", async () => {
        const workflow = {
            id: "wf-file-no-autocreate-fail",
            nodes: [{ id: "a", run: (() => undefined) as any }]
        } as any;

        const baseDir = path.join(tmpdir(), `wf-export-no-autocreate-${Date.now()}`);
        const nestedFile = path.join(baseDir, "missing", "workflow.json");

        await rm(baseDir, { recursive: true, force: true }).catch(() => undefined);

        await expect(WorkflowExporter.exportToFile(workflow, "json", nestedFile, false)).rejects.toThrow();
    });

    it("respects autoCreateDir=false by writing when parent dir already exists", async () => {
        const workflow = {
            id: "wf-file-no-autocreate-success",
            nodes: [{ id: "a", run: (() => undefined) as any }]
        } as any;

        const baseDir = path.join(tmpdir(), `wf-export-no-autocreate-ok-${Date.now()}`);
        const filePath = path.join(baseDir, "workflow.json");

        try {
            await WorkflowExporter.exportToFile(workflow, "json", filePath, true);
            await WorkflowExporter.exportToFile(workflow, "json", filePath, false);

            const content = await readFile(filePath, "utf-8");
            expect(JSON.parse(content).id).toBe("wf-file-no-autocreate-success");
        } finally {
            await rm(baseDir, { recursive: true, force: true }).catch(() => undefined);
        }
    });

    it("throws on unsupported export format", () => {
        const workflow = {
            id: "wf-bad-format",
            nodes: [{ id: "a", run: (() => undefined) as any }]
        } as any;

        expect(() => WorkflowExporter.export(workflow, "xml" as any)).toThrow("Unsupported export format: xml");
    });

});
