/**
 * @module core/workflow/WorkflowExporter.ts
 * @description ProviderPlaneAI source module.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { WorkflowError, type Workflow } from "#root/index.js";

/**
 * JSON-exported workflow node shape.
 *
 * @public
 */
export interface WorkflowJsonNode {
    id: string;
    dependsOn: string[];
}

/**
 * JSON-exported directed edge shape.
 *
 * @public
 */
export interface WorkflowJsonEdge {
    from: string;
    to: string;
}

/**
 * Full JSON workflow export payload.
 *
 * @public
 */
export interface WorkflowJsonExport {
    id: string;
    nodes: WorkflowJsonNode[];
    edges: WorkflowJsonEdge[];
}

/**
 * D3-compatible workflow export payload.
 *
 * @public
 */
export interface WorkflowD3Export {
    nodes: { id: string }[];
    edges: { from: string; to: string }[];
}

/**
 * Unified return type for {@link WorkflowExporter.export}.
 *
 * @public
 */
export type WorkflowExportResult = string | WorkflowJsonExport | WorkflowD3Export;

/**
 * Exports a Workflow definition to a Mermaid diagram, JSON-serializable format, DOT graph, or a D3-compatible format.
 * This can be used for visualization and diagnostic of workflow structures.
 * Note that exported workflows only include node ids and dependencies, not execution logic or metadata.
 *
 * @public
 */
export class WorkflowExporter {
    /**
     * Collects all node ids from explicit nodes and dependency references while preserving first-seen order.
     *
     * @param workflow Workflow to inspect
     * @returns Ordered unique node id list
     * @private
     */
    private static listAllNodeIdsInOrder(workflow: Workflow<unknown>): string[] {
        const idsInOrder: string[] = [];
        const seen = new Set<string>();

        for (const node of workflow.nodes) {
            if (!seen.has(node.id)) {
                seen.add(node.id);
                idsInOrder.push(node.id);
            }
            for (const dep of node.dependsOn ?? []) {
                if (!seen.has(dep)) {
                    seen.add(dep);
                    idsInOrder.push(dep);
                }
            }
        }

        return idsInOrder;
    }

    /**
     * Builds stable Mermaid-safe node identifiers (`n0`, `n1`, ...) for each discovered node id.
     *
     * @param workflow Workflow to map
     * @returns Map from original id to Mermaid-safe id
     * @private
     */
    private static buildMermaidNodeIdMap(workflow: Workflow<unknown>): Map<string, string> {
        const idsInOrder = this.listAllNodeIdsInOrder(workflow);

        const mapped = new Map<string, string>();
        idsInOrder.forEach((id, index) => mapped.set(id, `n${index}`));
        return mapped;
    }

    /**
     * Escapes label content for Mermaid node text.
     *
     * @param label Raw label text
     * @returns Escaped Mermaid-safe label
     * @private
     */
    private static escapeMermaidLabel(label: string): string {
        // Mermaid labels are sensitive to control chars and some bracket/quote combinations.
        // Normalize problematic characters to keep output parseable across renderers.
        return label
            .replace(/\\/g, "\\\\")
            .replace(/"/g, '\\"')
            .replace(/\r/g, "\\r")
            .replace(/\n/g, "\\n")
            .replace(/\t/g, "\\t")
            .replace(/\[/g, "&#91;")
            .replace(/\]/g, "&#93;");
    }

    /**
     * Quotes and escapes a Graphviz DOT string literal.
     *
     * @param value Raw DOT identifier/label
     * @returns Quoted DOT string
     * @private
     */
    private static quoteDot(value: string): string {
        return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
    }

    /**
     * Produces a deduplicated edge list from workflow dependencies.
     *
     * @param workflow Workflow to inspect
     * @returns Unique directed edges
     * @private
     */
    private static listUniqueEdges(workflow: Workflow<unknown>): WorkflowJsonEdge[] {
        const edges: WorkflowJsonEdge[] = [];
        const seen = new Set<string>();

        for (const node of workflow.nodes) {
            for (const dep of node.dependsOn ?? []) {
                // Use an impossible separator for ids to avoid accidental collisions.
                const key = `${dep}\u0000${node.id}`;
                if (seen.has(key)) {
                    continue;
                }
                seen.add(key);
                edges.push({ from: dep, to: node.id });
            }
        }

        return edges;
    }

    /**
     * Exports workflow graph as Mermaid syntax.
     *
     * @param workflow Workflow to export
     * @returns Mermaid graph source
     * @public
     */
    static workflowAsMermaid(workflow: Workflow<unknown>): string {
        const lines: string[] = ["graph TD"];
        const nodeIdMap = this.buildMermaidNodeIdMap(workflow);

        // Emit explicit node declarations for all ids we know about (including dependency-only ids),
        // so Mermaid doesn't create unlabeled implicit nodes.
        for (const [id, key] of nodeIdMap.entries()) {
            lines.push(`    ${key}["${this.escapeMermaidLabel(`${id}`)}"]`);
        }

        for (const edge of this.listUniqueEdges(workflow)) {
            // Safe because ids come from the same workflow scan used to build this map.
            const from = nodeIdMap.get(edge.from)!;
            const to = nodeIdMap.get(edge.to)!;
            lines.push(`    ${from} --> ${to}`);
        }

        return lines.join("\n");
    }

    /**
     * Exports workflow graph as Graphviz DOT.
     *
     * @param workflow Workflow to export
     * @returns DOT graph source
     * @public
     */
    static workflowAsDOT(workflow: Workflow<unknown>): string {
        const lines: string[] = ["digraph Workflow {"];
        const ids = this.listAllNodeIdsInOrder(workflow);

        // Explicitly declare all nodes (including dependency-only ids) for consistent graph output.
        for (const id of ids) {
            const nodeId = this.quoteDot(id);
            const nodeLabel = this.quoteDot(id);
            lines.push(`    ${nodeId} [label=${nodeLabel}];`);
        }

        for (const edge of this.listUniqueEdges(workflow)) {
            lines.push(`    ${this.quoteDot(edge.from)} -> ${this.quoteDot(edge.to)};`);
        }

        lines.push("}");
        return lines.join("\n");
    }

    /**
     * Exports workflow graph in a D3-friendly shape.
     *
     * @param workflow Workflow to export
     * @returns D3 nodes/edges payload
     * @public
     */
    static workflowAsD3(workflow: Workflow<unknown>): WorkflowD3Export {
        const nodes = this.listAllNodeIdsInOrder(workflow).map((id) => ({ id }));
        const edges = this.listUniqueEdges(workflow);

        return { nodes, edges };
    }

    /**
     * Exports workflow graph in a JSON-serializable structure.
     *
     * @param workflow Workflow to export
     * @returns JSON export payload
     * @public
     */
    static workflowAsJSON(workflow: Workflow<unknown>): WorkflowJsonExport {
        const allIds = this.listAllNodeIdsInOrder(workflow);
        const dependencyMap = new Map(workflow.nodes.map((node) => [node.id, Array.from(new Set(node.dependsOn ?? []))]));
        const nodes: WorkflowJsonNode[] = allIds.map((id) => ({
            id,
            dependsOn: dependencyMap.get(id) ?? []
        }));

        return {
            id: workflow.id,
            nodes,
            edges: this.listUniqueEdges(workflow)
        };
    }

    /**
     * Exports workflow in the requested format.
     *
     * @param workflow Workflow to export
     * @param format Target export format
     * @returns Export payload as string (mermaid/dot) or structured object (json/d3)
     * @throws {WorkflowError} When format is unsupported
     * @public
     */
    static export(workflow: Workflow<unknown>, format: "mermaid" | "json" | "dot" | "d3"): WorkflowExportResult {
        switch (format) {
            case "mermaid":
                return this.workflowAsMermaid(workflow);
            case "json":
                return this.workflowAsJSON(workflow);
            case "dot":
                return this.workflowAsDOT(workflow);
            case "d3":
                return this.workflowAsD3(workflow);
            default:
                throw new WorkflowError(`Unsupported export format: ${format}`);
        }
    }

    /**
     * Exports workflow and persists the result to disk.
     *
     * @param workflow Workflow to export
     * @param format Target export format
     * @param filePath Destination file path
     * @param autoCreateDir Whether to automatically create the parent directory if it doesn't exist (default: true)
     * @returns Promise resolved when file write completes
     * @throws {Error} When directory creation or file write fails
     * @public
     */
    static async exportToFile(
        workflow: Workflow<unknown>,
        format: "mermaid" | "json" | "dot" | "d3",
        filePath: string,
        autoCreateDir = true
    ): Promise<void> {
        // Keep directory creation optional so callers can enforce strict path expectations.
        if (autoCreateDir) {
            await mkdir(dirname(filePath), { recursive: true });
        }
        const data = this.export(workflow, format);
        if (typeof data === "string") {
            await writeFile(filePath, data, "utf-8");
        } else {
            await writeFile(filePath, JSON.stringify(data, null, 2), "utf-8");
        }
    }
}
