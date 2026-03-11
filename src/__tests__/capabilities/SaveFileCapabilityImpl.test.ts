import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
    createSaveFileExecutor,
    DEFAULT_SAVE_FILE_CAPABILITY_KEY,
    MultiModalExecutionContext,
    registerSaveFileCapability
} from "#root/index.js";

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

    it("registerSaveFileCapability registers default capability key and custom key", () => {
        const client = {
            registerCapabilityExecutor: vi.fn()
        } as any;

        const defaultRegistered = registerSaveFileCapability(client);
        expect(defaultRegistered.capabilityKey).toBe(DEFAULT_SAVE_FILE_CAPABILITY_KEY);
        expect(client.registerCapabilityExecutor).toHaveBeenCalledTimes(1);
        expect(client.registerCapabilityExecutor).toHaveBeenNthCalledWith(1, DEFAULT_SAVE_FILE_CAPABILITY_KEY, expect.any(Object));

        const customRegistered = registerSaveFileCapability(client, { capabilityKey: "customSaveFile" });
        expect(customRegistered.capabilityKey).toBe("customSaveFile");
        expect(client.registerCapabilityExecutor).toHaveBeenCalledTimes(2);
        expect(client.registerCapabilityExecutor).toHaveBeenNthCalledWith(2, "customSaveFile", expect.any(Object));
    });

    it("throws when request.input is missing", async () => {
        const exec = createSaveFileExecutor({ baseDir: tempDir });
        const ctx = new MultiModalExecutionContext();

        await expect(exec.invoke({} as any, {} as any, ctx)).rejects.toThrow("request.input is required");
    });

    it("throws when input.path is missing", async () => {
        const exec = createSaveFileExecutor({ baseDir: tempDir });
        const ctx = new MultiModalExecutionContext();

        await expect(
            exec.invoke(
                {} as any,
                {
                    input: {
                        text: "x"
                    }
                } as any,
                ctx
            )
        ).rejects.toThrow("input.path is required");
    });

    it("throws when contentType base64 is selected but base64 value is missing", async () => {
        const exec = createSaveFileExecutor({ baseDir: tempDir });
        const ctx = new MultiModalExecutionContext();

        await expect(
            exec.invoke(
                {} as any,
                {
                    input: {
                        path: "blob.bin",
                        contentType: "base64"
                    }
                },
                ctx
            )
        ).rejects.toThrow("input.base64 is required");
    });

    it("supports explicit encoding for text writes", async () => {
        const exec = createSaveFileExecutor({ baseDir: tempDir });
        const ctx = new MultiModalExecutionContext();

        const result = await exec.invoke(
            {} as any,
            {
                input: {
                    path: "utf16.txt",
                    text: "Hello",
                    encoding: "utf16le"
                }
            },
            ctx
        );

        expect(result.output.bytesWritten).toBe(Buffer.byteLength("Hello", "utf16le"));
        expect(await readFile(result.output.path, "utf16le")).toBe("Hello");
    });

    it("writes json null when contentType json is selected without json payload", async () => {
        const exec = createSaveFileExecutor({ baseDir: tempDir });
        const ctx = new MultiModalExecutionContext();

        const result = await exec.invoke(
            {} as any,
            {
                input: {
                    path: "null.json",
                    contentType: "json"
                }
            },
            ctx
        );

        expect(result.output.contentType).toBe("json");
        expect(await readFile(result.output.path, "utf8")).toBe("null");
    });

    it("allows absolute path writes when allowAbsolutePath is true", async () => {
        const exec = createSaveFileExecutor({ allowAbsolutePath: true });
        const ctx = new MultiModalExecutionContext();
        const absoluteTarget = path.resolve(tempDir, "absolute-ok.txt");

        const result = await exec.invoke(
            {} as any,
            {
                input: {
                    path: absoluteTarget,
                    text: "allowed"
                }
            },
            ctx
        );

        expect(result.output.path).toBe(absoluteTarget);
        expect(await readFile(absoluteTarget, "utf8")).toBe("allowed");
    });

    it("uses capability key in response metadata and id prefix", async () => {
        const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1234567890);
        try {
            const exec = createSaveFileExecutor({ baseDir: tempDir }, "customSave");
            const ctx = new MultiModalExecutionContext();

            const result = await exec.invoke(
                {} as any,
                {
                    input: {
                        path: "meta.txt",
                        text: "ok"
                    }
                },
                ctx
            );

            expect(result.id).toBe("customSave-1234567890");
            expect((result.metadata as any)?.capabilityKey).toBe("customSave");
            expect(result.rawResponse).toEqual({ requestedPath: "meta.txt" });
        } finally {
            nowSpy.mockRestore();
        }
    });
});
