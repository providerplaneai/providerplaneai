#!/usr/bin/env node
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";

const execFileAsync = promisify(execFile);

const defaultCiThresholds = {
    maxTarballSizeBytes: 331101, // +10% over ~301001 baseline
    maxColdImportMedianMs: 500,
    maxColdImportP95Ms: 1000,
    maxClientRunnerDeltaMB: 2
};

function parseArgs(argv) {
    let runs = 20;
    let outDir = "scripts/perf/results";
    let ci = false;
    const thresholds = { ...defaultCiThresholds };
    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        if (arg === "--runs") {
            const next = argv[i + 1];
            if (next) {
                runs = Number(next);
                i += 1;
            }
        } else if (arg === "--out-dir") {
            const next = argv[i + 1];
            if (next) {
                outDir = next;
                i += 1;
            }
        } else if (arg === "--ci") {
            ci = true;
        } else if (arg === "--max-tarball-bytes") {
            const next = argv[i + 1];
            if (next) {
                thresholds.maxTarballSizeBytes = Number(next);
                i += 1;
            }
        } else if (arg === "--max-cold-median-ms") {
            const next = argv[i + 1];
            if (next) {
                thresholds.maxColdImportMedianMs = Number(next);
                i += 1;
            }
        } else if (arg === "--max-cold-p95-ms") {
            const next = argv[i + 1];
            if (next) {
                thresholds.maxColdImportP95Ms = Number(next);
                i += 1;
            }
        } else if (arg === "--max-client-runner-delta-mb") {
            const next = argv[i + 1];
            if (next) {
                thresholds.maxClientRunnerDeltaMB = Number(next);
                i += 1;
            }
        }
    }
    if (!Number.isFinite(runs) || runs <= 0) {
        runs = 20;
    }
    return { runs, outDir, ci, thresholds };
}

function nowStamp() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

function bytesToMB(bytes) {
    return Number((bytes / (1024 * 1024)).toFixed(2));
}

function percentile(values, p) {
    if (values.length === 0) {
        return 0;
    }
    const sorted = [...values].sort((a, b) => a - b);
    const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
    return sorted[idx];
}

function summarizeMs(values) {
    if (values.length === 0) {
        return { runs: 0, minMs: 0, maxMs: 0, meanMs: 0, medianMs: 0, p95Ms: 0 };
    }
    const sum = values.reduce((a, b) => a + b, 0);
    return {
        runs: values.length,
        minMs: Number(Math.min(...values).toFixed(2)),
        maxMs: Number(Math.max(...values).toFixed(2)),
        meanMs: Number((sum / values.length).toFixed(2)),
        medianMs: Number(percentile(values, 50).toFixed(2)),
        p95Ms: Number(percentile(values, 95).toFixed(2))
    };
}

async function npmPackMetrics() {
    const temp = await mkdtemp(join(tmpdir(), "providerplane-pack-"));
    const cacheDir = resolve(process.cwd(), ".perf-npm-cache");
    await mkdir(cacheDir, { recursive: true });
    try {
        try {
            await execFileAsync(
                "npm",
                ["pack", "--ignore-scripts", "--cache", cacheDir, "--pack-destination", temp],
                {
                    cwd: process.cwd(),
                    maxBuffer: 10 * 1024 * 1024
                }
            );
        } catch (error) {
            const e = error;
            const extra = [e?.stdout, e?.stderr].filter(Boolean).join("\n");
            throw new Error(`npm pack failed${extra ? `: ${extra}` : ""}`);
        }

        const files = await readdir(temp);
        const tarball = files.find((file) => file.endsWith(".tgz"));
        if (!tarball) {
            throw new Error("npm pack succeeded but no tarball was found in pack destination");
        }
        const tarballPath = join(temp, tarball);
        const tarballStat = await stat(tarballPath);

        const unpackDir = join(temp, "unpacked");
        await mkdir(unpackDir, { recursive: true });
        await execFileAsync("tar", ["-xzf", tarballPath, "-C", unpackDir], {
            cwd: process.cwd(),
            maxBuffer: 10 * 1024 * 1024
        });

        const walkSize = async (dir) => {
            let total = 0;
            const entries = await readdir(dir, { withFileTypes: true });
            for (const entry of entries) {
                const full = join(dir, entry.name);
                if (entry.isDirectory()) {
                    total += await walkSize(full);
                } else if (entry.isFile()) {
                    total += (await stat(full)).size;
                }
            }
            return total;
        };
        const unpackedSize = await walkSize(unpackDir);

        const pkgJson = JSON.parse(await readFile(join(process.cwd(), "package.json"), "utf8"));
        return {
            name: pkgJson.name,
            version: pkgJson.version,
            filename: tarball,
            tarballSizeBytes: tarballStat.size,
            unpackedSizeBytes: unpackedSize
        };
    } finally {
        await rm(temp, { recursive: true, force: true });
    }
}

async function npmDependencyMetrics(root) {
    const pkgJson = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
    const directDeps = Object.keys(pkgJson.dependencies ?? {});
    const lockPath = join(root, "package-lock.json");
    let transitiveCount = 0;
    try {
        const lockJson = JSON.parse(await readFile(lockPath, "utf8"));
        if (lockJson && typeof lockJson === "object" && lockJson.packages && typeof lockJson.packages === "object") {
            transitiveCount = Object.entries(lockJson.packages).filter(([pathKey, pkg]) => {
                if (!pathKey) {
                    return false;
                }
                if (!pkg || typeof pkg !== "object") {
                    return false;
                }
                return !pkg.dev;
            }).length;
        }
    } catch {
        transitiveCount = 0;
    }

    return {
        directDependencyCount: directDeps.length,
        transitiveDependencyCount: transitiveCount
    };
}

function parseLastJsonLine(stdout, label) {
    const lines = String(stdout)
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
    for (let i = lines.length - 1; i >= 0; i -= 1) {
        const line = lines[i];
        try {
            return JSON.parse(line);
        } catch {
            // Keep scanning for a valid JSON line (provider init logs may precede JSON).
        }
    }
    throw new Error(`Unable to parse JSON output for ${label}. Raw stdout: ${stdout}`);
}

async function coldImportMetrics(distIndexFileUrl, runs) {
    const values = [];
    const workerSource = `
import { parentPort, workerData } from "node:worker_threads";
import { performance } from "node:perf_hooks";
const t0 = performance.now();
await import(\`\${workerData.target}?r=\${Math.random()}\`);
const elapsed = performance.now() - t0;
parentPort.postMessage(elapsed);
`;
    for (let i = 0; i < runs; i += 1) {
        const ms = await new Promise((resolveRun, rejectRun) => {
            const worker = new Worker(workerSource, {
                eval: true,
                type: "module",
                workerData: { target: distIndexFileUrl }
            });
            worker.once("message", (value) => resolveRun(Number(value)));
            worker.once("error", rejectRun);
            worker.once("exit", (code) => {
                if (code !== 0) {
                    rejectRun(new Error(`Cold import worker exited with code ${code}`));
                }
            });
        });
        if (!Number.isFinite(ms)) {
            throw new Error(`Invalid cold import measurement: ${String(ms)}`);
        }
        values.push(ms);
    }
    return summarizeMs(values);
}

async function memoryMetrics(distIndexFileUrl) {
    const mod = await import(distIndexFileUrl);
    if (globalThis.gc) {
        globalThis.gc();
    }
    const importOnlyRssBytes = process.memoryUsage().rss;
    const beforeBytes = process.memoryUsage().rss;
    const client = new mod.AIClient();
    const runner = new mod.WorkflowRunner({ jobManager: client.jobManager, client });
    void runner;
    if (globalThis.gc) {
        globalThis.gc();
    }
    const afterBytes = process.memoryUsage().rss;
    const deltaBytes = afterBytes - beforeBytes;

    return {
        importOnlyRssBytes,
        importOnlyRssMB: bytesToMB(importOnlyRssBytes),
        withClientRunnerBeforeBytes: beforeBytes,
        withClientRunnerAfterBytes: afterBytes,
        withClientRunnerDeltaBytes: deltaBytes,
        withClientRunnerDeltaMB: bytesToMB(deltaBytes)
    };
}

function renderMarkdown(result) {
    const lines = [];
    lines.push("# Performance Report");
    lines.push("");
    lines.push(`Generated: ${result.generatedAt}`);
    lines.push(`Node: ${result.node.version} (${result.node.platform}/${result.node.arch})`);
    lines.push("");
    lines.push("## Package Footprint");
    lines.push("");
    lines.push(`- Name: \`${result.package.name}\``);
    lines.push(`- Version: \`${result.package.version}\``);
    lines.push(`- Tarball: **${result.package.tarballSizeBytes} bytes** (${bytesToMB(result.package.tarballSizeBytes)} MB)`);
    lines.push(`- Unpacked: **${result.package.unpackedSizeBytes} bytes** (${bytesToMB(result.package.unpackedSizeBytes)} MB)`);
    lines.push("");
    lines.push("## Dependency Footprint");
    lines.push("");
    lines.push(`- Direct prod deps: **${result.dependencies.directDependencyCount}**`);
    lines.push(`- Transitive prod deps: **${result.dependencies.transitiveDependencyCount}**`);
    lines.push("");
    lines.push("## Cold Import (dist/index.js)");
    lines.push("");
    lines.push(`- Runs: **${result.coldImport.runs}**`);
    lines.push(`- Min: **${result.coldImport.minMs} ms**`);
    lines.push(`- Median: **${result.coldImport.medianMs} ms**`);
    lines.push(`- P95: **${result.coldImport.p95Ms} ms**`);
    lines.push(`- Max: **${result.coldImport.maxMs} ms**`);
    lines.push(`- Mean: **${result.coldImport.meanMs} ms**`);
    lines.push("");
    lines.push("## Memory Baseline");
    lines.push("");
    lines.push(`- RSS after import: **${result.memory.importOnlyRssMB} MB**`);
    lines.push(
        `- RSS delta after \`new AIClient()\` + \`new WorkflowRunner(...)\`: **${result.memory.withClientRunnerDeltaMB} MB**`
    );
    lines.push("");
    if (result.ci) {
        lines.push("## CI Threshold Check");
        lines.push("");
        lines.push(`- Status: **${result.ci.passed ? "PASS" : "FAIL"}**`);
        for (const check of result.ci.checks) {
            lines.push(
                `- ${check.name}: ${check.value} ${check.op} ${check.limit} -> **${check.pass ? "PASS" : "FAIL"}**`
            );
        }
        lines.push("");
    }
    return `${lines.join("\n")}\n`;
}

function evaluateCiThresholds(result, thresholds) {
    const checks = [
        {
            name: "tarballSizeBytes",
            value: result.package.tarballSizeBytes,
            op: "<=",
            limit: thresholds.maxTarballSizeBytes,
            pass: result.package.tarballSizeBytes <= thresholds.maxTarballSizeBytes
        },
        {
            name: "coldImport.medianMs",
            value: result.coldImport.medianMs,
            op: "<=",
            limit: thresholds.maxColdImportMedianMs,
            pass: result.coldImport.medianMs <= thresholds.maxColdImportMedianMs
        },
        {
            name: "coldImport.p95Ms",
            value: result.coldImport.p95Ms,
            op: "<=",
            limit: thresholds.maxColdImportP95Ms,
            pass: result.coldImport.p95Ms <= thresholds.maxColdImportP95Ms
        },
        {
            name: "memory.withClientRunnerDeltaMB",
            value: result.memory.withClientRunnerDeltaMB,
            op: "<=",
            limit: thresholds.maxClientRunnerDeltaMB,
            pass: result.memory.withClientRunnerDeltaMB <= thresholds.maxClientRunnerDeltaMB
        }
    ];
    return {
        passed: checks.every((check) => check.pass),
        checks,
        thresholds
    };
}

async function main() {
    const { runs, outDir, ci, thresholds } = parseArgs(process.argv.slice(2));
    const root = process.cwd();
    const distIndexPath = resolve(root, "dist/index.js");
    const distIndexFileUrl = pathToFileURL(distIndexPath).href;

    const [pkg, deps, coldImport, memory] = await Promise.all([
        npmPackMetrics(),
        npmDependencyMetrics(root),
        coldImportMetrics(distIndexFileUrl, runs),
        memoryMetrics(distIndexFileUrl)
    ]);

    const result = {
        generatedAt: new Date().toISOString(),
        node: {
            version: process.version,
            platform: process.platform,
            arch: process.arch
        },
        package: pkg,
        dependencies: deps,
        coldImport,
        memory
    };

    if (ci) {
        result.ci = evaluateCiThresholds(result, thresholds);
    }

    const stamp = nowStamp();
    const outPath = resolve(root, outDir);
    await mkdir(outPath, { recursive: true });
    const jsonPath = join(outPath, `perf-${stamp}.json`);
    const mdPath = join(outPath, `perf-${stamp}.md`);
    const latestJsonPath = join(outPath, "latest.json");
    const latestMdPath = join(outPath, "latest.md");

    await writeFile(jsonPath, JSON.stringify(result, null, 2));
    await writeFile(mdPath, renderMarkdown(result));
    await writeFile(latestJsonPath, JSON.stringify(result, null, 2));
    await writeFile(latestMdPath, renderMarkdown(result));

    console.log(`Perf JSON: ${jsonPath}`);
    console.log(`Perf MD:   ${mdPath}`);
    console.log(`Latest:    ${latestJsonPath}`);
    if (ci) {
        console.log(`CI status: ${result.ci.passed ? "PASS" : "FAIL"}`);
        for (const check of result.ci.checks) {
            console.log(
                ` - ${check.name}: ${check.value} ${check.op} ${check.limit} => ${check.pass ? "PASS" : "FAIL"}`
            );
        }
        if (!result.ci.passed) {
            process.exitCode = 2;
        }
    }
}

main().catch(async (error) => {
    console.error("Perf run failed:", error instanceof Error ? error.message : error);
    if (error instanceof Error && error.stack) {
        console.error(error.stack);
    }
    process.exitCode = 1;
});
