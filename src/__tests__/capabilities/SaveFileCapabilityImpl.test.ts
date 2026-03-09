import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createSaveFileExecutor, MultiModalExecutionContext } from "#root/index.js";

describe("SaveFileCapabilityImpl", () => {
    let tempDir = "";

    beforeEach(async () => {
        tempDir = await mkdtemp(path.join(os.tmpdir(), "ppai-savefile-"));
    });

    afterEach(async () => {
        if (tempDir) {
            await rm(tempDir, { recursive: true, force: true });
        }
    });

    it("writes text content and returns output metadata", async () => {
        const exec = createSaveFileExecutor({ baseDir: tempDir });
        const ctx = new MultiModalExecutionContext();

        const result = await exec.invoke(
            {} as any,
            {
                input: {
                    path: "nested/output.txt",
                    text: "hello save file"
                }
            },
            ctx
        );

        expect(result.output.contentType).toBe("text");
        expect(result.output.bytesWritten).toBe(Buffer.byteLength("hello save file", "utf8"));
        expect(result.output.path).toBe(path.join(tempDir, "nested/output.txt"));
        const content = await readFile(result.output.path, "utf8");
        expect(content).toBe("hello save file");
    });

    it("writes base64 content", async () => {
        const exec = createSaveFileExecutor({ baseDir: tempDir });
        const ctx = new MultiModalExecutionContext();
        const payload = Buffer.from("binary-payload", "utf8");

        const result = await exec.invoke(
            {} as any,
            {
                input: {
                    path: "blob.bin",
                    contentType: "base64",
                    base64: payload.toString("base64")
                }
            },
            ctx
        );

        expect(result.output.contentType).toBe("base64");
        expect(result.output.bytesWritten).toBe(payload.byteLength);
        const content = await readFile(result.output.path);
        expect(content.equals(payload)).toBe(true);
    });

    it("writes json content", async () => {
        const exec = createSaveFileExecutor({ baseDir: tempDir });
        const ctx = new MultiModalExecutionContext();
        const payload = { a: 1, nested: { ok: true } };

        const result = await exec.invoke(
            {} as any,
            {
                input: {
                    path: "payload.json",
                    contentType: "json",
                    json: payload
                }
            },
            ctx
        );

        expect(result.output.contentType).toBe("json");
        const raw = await readFile(result.output.path, "utf8");
        expect(JSON.parse(raw)).toEqual(payload);
    });

    it("rejects absolute paths when allowAbsolutePath is false", async () => {
        const exec = createSaveFileExecutor({ baseDir: tempDir, allowAbsolutePath: false });
        const ctx = new MultiModalExecutionContext();
        const absolute = path.resolve(tempDir, "abs.txt");

        await expect(
            exec.invoke(
                {} as any,
                {
                    input: {
                        path: absolute,
                        text: "x"
                    }
                },
                ctx
            )
        ).rejects.toThrow("absolute paths are not allowed");
    });

    it("rejects paths that escape baseDir", async () => {
        const exec = createSaveFileExecutor({ baseDir: tempDir });
        const ctx = new MultiModalExecutionContext();

        await expect(
            exec.invoke(
                {} as any,
                {
                    input: {
                        path: "../escape.txt",
                        text: "x"
                    }
                },
                ctx
            )
        ).rejects.toThrow("path escapes baseDir");
    });

    it("fails when autoCreateDir is false and target directory does not exist", async () => {
        const exec = createSaveFileExecutor({ baseDir: tempDir, autoCreateDir: false });
        const ctx = new MultiModalExecutionContext();

        await expect(
            exec.invoke(
                {} as any,
                {
                    input: {
                        path: "missing-dir/file.txt",
                        text: "x"
                    }
                },
                ctx
            )
        ).rejects.toThrow();
    });

    it("writes successfully with autoCreateDir false when parent exists", async () => {
        const exec = createSaveFileExecutor({ baseDir: tempDir, autoCreateDir: false });
        const ctx = new MultiModalExecutionContext();
        await mkdir(path.join(tempDir, "existing"), { recursive: true });

        const result = await exec.invoke(
            {} as any,
            {
                input: {
                    path: "existing/file.txt",
                    text: "ok"
                }
            },
            ctx
        );

        expect(result.output.path).toBe(path.join(tempDir, "existing/file.txt"));
        expect(await readFile(result.output.path, "utf8")).toBe("ok");
    });
});
