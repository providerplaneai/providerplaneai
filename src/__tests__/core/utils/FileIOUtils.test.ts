import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";

import {
    extractBlobName,
    fileNameFromPath,
    isBlobLike,
    isNodeReadableStream,
    pathExists,
    readFileToBuffer,
    readFileToUint8Array,
    readNodeReadableStreamToBuffer,
    readNodeReadableStreamToUint8Array
} from "#root/core/utils/FileIOUtils.js";

const tempDirs: string[] = [];

describe("FileIOUtils", () => {
    afterEach(async () => {
        await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
    });

    it("derives stable filenames from paths", () => {
        expect(fileNameFromPath("/tmp/audio.wav", "fallback")).toBe("audio.wav");
        expect(fileNameFromPath("C:\\temp\\voice.mp3", "fallback")).toBe("voice.mp3");
        expect(fileNameFromPath("", "fallback")).toBe("fallback");
    });

    it("detects blob-like values and extracts optional names", () => {
        const blobLike = {
            type: "text/plain",
            name: "notes.txt",
            arrayBuffer: async () => new ArrayBuffer(0)
        } as any;

        expect(isBlobLike(blobLike)).toBe(true);
        expect(isBlobLike({})).toBe(false);
        expect(extractBlobName(blobLike)).toBe("notes.txt");
    });

    it("checks path existence and reads local files", async () => {
        const dir = await mkdtemp(path.join(tmpdir(), "ppai-file-io-"));
        tempDirs.push(dir);
        const filePath = path.join(dir, "sample.txt");
        await writeFile(filePath, "hello");

        await expect(pathExists(filePath)).resolves.toBe(true);
        await expect(pathExists(path.join(dir, "missing.txt"))).resolves.toBe(false);
        await expect(readFileToBuffer(filePath)).resolves.toEqual(Buffer.from("hello"));
        await expect(readFileToUint8Array(filePath)).resolves.toEqual(new Uint8Array(Buffer.from("hello")));
    });

    it("detects node readable streams and drains them", async () => {
        const stream = Readable.from([Buffer.from("he"), Buffer.from("llo")]);

        expect(isNodeReadableStream(stream)).toBe(true);
        await expect(readNodeReadableStreamToBuffer(Readable.from(["a", "b"]))).resolves.toEqual(Buffer.from("ab"));
        await expect(readNodeReadableStreamToUint8Array(Readable.from([Buffer.from("ok")]))).resolves.toEqual(
            new Uint8Array(Buffer.from("ok"))
        );
    });
});
