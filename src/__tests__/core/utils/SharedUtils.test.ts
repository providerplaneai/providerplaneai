import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const configState = vi.hoisted(() => ({ appConfig: {} as Record<string, unknown> }));
const configHasMock = vi.hoisted(() => vi.fn((key: string) => key === "providerplane"));
const configGetMock = vi.hoisted(() => vi.fn(() => ({ appConfig: configState.appConfig })));
const lookupMock = vi.hoisted(() => vi.fn());

vi.mock("config", () => ({
    default: {
        has: configHasMock,
        get: configGetMock
    }
}));

vi.mock("node:dns/promises", () => ({
    lookup: lookupMock
}));

import {
    dataUriToUint8Array,
    ensureDataUri,
    expectArrayForCapability,
    expectObjectForCapability,
    logProviderAttempts,
    logRawBudgetDiagnostics,
    parseDataUri,
    parseBestEffortJson,
    readNumber,
    resolveImageToBytes,
    sanitizeTimelineArtifacts,
    summarizeSnapshot,
    stripBinaryPayloadFields,
    stripDataUriPrefix,
    toDataUrl,
    validateBoolean,
    validateNonNegativeInteger
} from "#root/core/utils/SharedUtils.js";
import { getMimeTypeForExtensionOrFormat, inferMimeTypeFromFilename } from "#root/core/utils/MimeTypeUtils.js";

function makeReader(chunks: number[][]) {
    const queue = chunks.map((c) => Uint8Array.from(c));
    return {
        read: vi.fn(async () => {
            if (!queue.length) {
                return { done: true, value: undefined };
            }
            return { done: false, value: queue.shift() };
        })
    };
}

describe("SharedUtils", () => {
    beforeEach(() => {
        vi.restoreAllMocks();
        configState.appConfig = { remoteImageFetchTimeoutMs: 5000 };
        configHasMock.mockImplementation((key: string) => key === "providerplane");
        configGetMock.mockImplementation(() => ({ appConfig: configState.appConfig }));
        lookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    });

    afterEach(() => {
        vi.resetAllMocks();
        try {
            delete (globalThis as any).fetch;
        } catch {
            // noop
        }
    });

    it("summarizeSnapshot returns stable fields", () => {
        const value = summarizeSnapshot({ id: "j1", status: "completed", input: {} } as any);
        expect(value).toContain("id=j1");
        expect(value).toContain("status=completed");
        expect(value).toContain("schemaVersion=1");
    });

    it("logProviderAttempts logs none and serialized attempts", () => {
        const spy = vi.spyOn(console, "log").mockImplementation(() => undefined);

        logProviderAttempts("test", undefined);
        logProviderAttempts("test", { providerAttempts: [{ provider: "openai" }] });

        expect(spy).toHaveBeenCalledTimes(2);
        expect(spy.mock.calls[0]?.[0]).toContain("providerAttempts: none");
        expect(spy.mock.calls[1]?.[0]).toContain("providerAttempts:");
        expect(spy.mock.calls[1]?.[1]).toEqual([{ provider: "openai" }]);
    });

    it("logRawBudgetDiagnostics logs expected payload diagnostics", () => {
        const spy = vi.spyOn(console, "log").mockImplementation(() => undefined);
        logRawBudgetDiagnostics("budget", {
            rawPayloadDropped: true,
            rawPayloadDroppedCount: 2,
            rawPayloadDroppedBytes: 30,
            rawPayloadStoredBytes: 10
        });
        expect(spy).toHaveBeenCalledOnce();
        expect(spy.mock.calls[0]?.[0]).toContain("raw diagnostics");
        expect(spy.mock.calls[0]?.[1]).toMatchObject({
            rawPayloadDropped: true,
            rawPayloadDroppedCount: 2,
            rawPayloadDroppedBytes: 30,
            rawPayloadStoredBytes: 10
        });
    });

    it("validateBoolean accepts booleans and undefined and rejects other values", () => {
        expect(() => validateBoolean(undefined, "x")).not.toThrow();
        expect(() => validateBoolean(true, "x")).not.toThrow();
        expect(() => validateBoolean(false, "x")).not.toThrow();
        expect(() => validateBoolean("true", "x")).toThrow("Invalid field x: expected a boolean");
    });

    it("stripBinaryPayloadFields removes base64 and data URLs recursively", () => {
        const input = {
            base64: "AAAA",
            url: "data:video/mp4;base64,AAAA",
            nested: {
                keep: true,
                base64: "BBBB",
                remoteUrl: "https://example.com/video.mp4"
            },
            arr: [{ base64: "CCCC", mimeType: "video/mp4" }]
        };

        const out = stripBinaryPayloadFields(input) as any;
        expect(out.base64).toBeUndefined();
        expect(out.url).toBeUndefined();
        expect(out.nested.base64).toBeUndefined();
        expect(out.nested.remoteUrl).toBe("https://example.com/video.mp4");
        expect(out.arr[0].base64).toBeUndefined();
        expect(out.arr[0].mimeType).toBe("video/mp4");
    });

    it("sanitizeTimelineArtifacts strips binary-heavy artifact payloads", () => {
        const out = sanitizeTimelineArtifacts({
            video: [{ id: "v1", mimeType: "video/mp4", base64: "AAAA" } as any]
        }) as any;

        expect(out.video[0].id).toBe("v1");
        expect(out.video[0].base64).toBeUndefined();
    });

    it("ensureDataUri returns existing data URI and prepends when needed", () => {
        expect(ensureDataUri("data:image/png;base64,AAA")).toBe("data:image/png;base64,AAA");
        expect(ensureDataUri("AAA")).toBe("data:application/octet-stream;base64,AAA");
        expect(ensureDataUri("AAA", "image/jpeg")).toBe("data:image/jpeg;base64,AAA");
    });

    it("parseDataUri decodes base64 and urlencoded payloads", () => {
        expect(parseDataUri("data:audio/mpeg;base64,AQID")).toEqual({
            bytes: new Uint8Array([1, 2, 3]),
            mimeType: "audio/mpeg",
            isBase64: true
        });

        expect(parseDataUri("data:text/plain,hello%20world")).toEqual({
            bytes: new Uint8Array(Buffer.from("hello world")),
            mimeType: "text/plain",
            isBase64: false
        });

        expect(parseDataUri("data:;base64,AQID")).toEqual({
            bytes: new Uint8Array([1, 2, 3]),
            mimeType: "application/octet-stream",
            isBase64: true
        });

        expect(() => parseDataUri("not-a-data-uri")).toThrow("Invalid data URL");
    });

    it("dataUriToUint8Array decodes bytes from a data URI", () => {
        expect(dataUriToUint8Array("data:audio/mpeg;base64,AQID")).toEqual(new Uint8Array([1, 2, 3]));
    });

    it("stripDataUriPrefix removes data-uri headers and trims raw payloads", () => {
        expect(stripDataUriPrefix("data:audio/mpeg;base64,AQID")).toBe("AQID");
        expect(stripDataUriPrefix("data:text/plain,hello%20world")).toBe("hello%20world");
        expect(stripDataUriPrefix("  AQID  ")).toBe("AQID");
    });

    it("getMimeTypeForExtensionOrFormat resolves common extension and format tokens", () => {
        expect(getMimeTypeForExtensionOrFormat("mp3")).toBe("audio/mpeg");
        expect(getMimeTypeForExtensionOrFormat(".wav")).toBe("audio/wav");
        expect(getMimeTypeForExtensionOrFormat("clip.m4a")).toBe("audio/mp4");
        expect(getMimeTypeForExtensionOrFormat("report.pdf")).toBe("application/pdf");
        expect(getMimeTypeForExtensionOrFormat("sheet.xlsx")).toBe(
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        );
        expect(getMimeTypeForExtensionOrFormat("unknown", "application/octet-stream")).toBe("application/octet-stream");
    });

    it("inferMimeTypeFromFilename resolves mime types from filenames and paths", () => {
        expect(inferMimeTypeFromFilename("image.jpeg")).toBe("image/jpeg");
        expect(inferMimeTypeFromFilename("/tmp/archive/file.webm")).toBe("audio/webm");
        expect(inferMimeTypeFromFilename("notes.txt")).toBe("text/plain");
        expect(inferMimeTypeFromFilename(undefined, "application/octet-stream")).toBe("application/octet-stream");
    });

    it("toDataUrl validates base64 and applies default mime", () => {
        expect(() => toDataUrl({} as any)).toThrow("Requires base64");
        expect(toDataUrl({ base64: "ABC" } as any)).toBe("data:image/png;base64,ABC");
        expect(toDataUrl({ base64: "ABC", mimeType: "image/webp" } as any)).toBe("data:image/webp;base64,ABC");
    });

    it("resolveImageToBytes supports data URL and enforces configured max size", async () => {
        configState.appConfig = { maxRemoteImageBytes: 2 };

        await expect(resolveImageToBytes("data:image/png;base64,QQ==")).resolves.toEqual(Buffer.from("A"));
        await expect(resolveImageToBytes("data:image/png;base64,QUJD")).rejects.toThrow("Image exceeds max allowed size");
        await expect(resolveImageToBytes("data:image/png;base64,")).rejects.toThrow("Invalid Data URL format");
    });

    it("resolveImageToBytes fetches remote image and concatenates streamed chunks", async () => {
        const reader = makeReader([[1, 2], [3]]);
        (globalThis as any).fetch = vi.fn(async () => ({
            ok: true,
            statusText: "OK",
            headers: { get: () => null },
            body: { getReader: () => reader }
        }));

        const out = await resolveImageToBytes("https://example.com/image.png");
        expect(out.equals(Buffer.from([1, 2, 3]))).toBe(true);
        expect(lookupMock).toHaveBeenCalled();
    });

    it("resolveImageToBytes allows direct public IPv4/IPv6 hosts and skips DNS lookup", async () => {
        (globalThis as any).fetch = vi.fn(async () => ({
            ok: true,
            statusText: "OK",
            headers: { get: () => "2" },
            body: { getReader: () => makeReader([[1], [2]]) }
        }));

        const out4 = await resolveImageToBytes("https://8.8.8.8/x.png");
        const out6 = await resolveImageToBytes("https://[2001:4860:4860::8888]/x.png");
        expect(out4.equals(Buffer.from([1, 2]))).toBe(true);
        expect(out6.equals(Buffer.from([1, 2]))).toBe(true);
        expect(lookupMock).toHaveBeenCalledOnce();
    });

    it("resolveImageToBytes rejects unsafe or invalid remote URLs", async () => {
        (globalThis as any).fetch = vi.fn();

        await expect(resolveImageToBytes("http://localhost/a.png")).rejects.toThrow("Could not resolve reference image");
        await expect(resolveImageToBytes("ftp://example.com/a.png")).rejects.toThrow("Could not resolve reference image");
        await expect(resolveImageToBytes("not-a-url")).rejects.toThrow("Could not resolve reference image");

        expect((globalThis as any).fetch).not.toHaveBeenCalled();
    });

    it("resolveImageToBytes blocks private IPv4 and IPv6 targets", async () => {
        (globalThis as any).fetch = vi.fn();

        await expect(resolveImageToBytes("http://127.0.0.1/x.png")).rejects.toThrow("Could not resolve reference image");
        await expect(resolveImageToBytes("http://10.0.0.1/x.png")).rejects.toThrow("Could not resolve reference image");
        await expect(resolveImageToBytes("http://172.16.0.1/x.png")).rejects.toThrow("Could not resolve reference image");
        await expect(resolveImageToBytes("http://192.168.0.1/x.png")).rejects.toThrow("Could not resolve reference image");
        await expect(resolveImageToBytes("http://[::1]/x.png")).rejects.toThrow("Could not resolve reference image");
        await expect(resolveImageToBytes("http://[fc00::1]/x.png")).rejects.toThrow("Could not resolve reference image");
        await expect(resolveImageToBytes("http://[fd00::1]/x.png")).rejects.toThrow("Could not resolve reference image");
        await expect(resolveImageToBytes("http://[fe80::1]/x.png")).rejects.toThrow("Could not resolve reference image");
        await expect(resolveImageToBytes("http://[::ffff:127.0.0.1]/x.png")).rejects.toThrow(
            "Could not resolve reference image"
        );
        await expect(resolveImageToBytes("http://[::ffff:7f00:1]/x.png")).rejects.toThrow("Could not resolve reference image");
    });

    it("resolveImageToBytes allows non-private IPv4-mapped IPv6 targets", async () => {
        (globalThis as any).fetch = vi.fn(async () => ({
            ok: true,
            statusText: "OK",
            headers: { get: () => null },
            body: { getReader: () => makeReader([[1]]) }
        }));

        await expect(resolveImageToBytes("http://[::ffff:8.8.8.8]/x.png")).resolves.toEqual(Buffer.from([1]));
        await expect(resolveImageToBytes("http://[::ffff:0808:0808]/x.png")).resolves.toEqual(Buffer.from([1]));
    });

    it("resolveImageToBytes blocks DNS resolutions to private addresses", async () => {
        lookupMock.mockResolvedValueOnce([{ address: "10.1.1.1", family: 4 }]);
        (globalThis as any).fetch = vi.fn();

        await expect(resolveImageToBytes("https://example.com/x.png")).rejects.toThrow("Could not resolve reference image");
        expect((globalThis as any).fetch).not.toHaveBeenCalled();
    });

    it("resolveImageToBytes blocks DNS resolutions to private IPv6 and malformed addresses", async () => {
        lookupMock.mockResolvedValueOnce([{ address: "fe80::1", family: 6 }]);
        (globalThis as any).fetch = vi.fn();
        await expect(resolveImageToBytes("https://example.com/v6.png")).rejects.toThrow("Could not resolve reference image");

        lookupMock.mockResolvedValueOnce([{ address: "999.999.999.999", family: 4 }]);
        await expect(resolveImageToBytes("https://example.com/bad-ip.png")).rejects.toThrow("Could not resolve reference image");
        expect((globalThis as any).fetch).not.toHaveBeenCalled();
    });

    it("resolveImageToBytes handles IPv4-mapped IPv6 DNS targets for dotted, hex, and malformed tails", async () => {
        (globalThis as any).fetch = vi.fn(async () => ({
            ok: true,
            statusText: "OK",
            headers: { get: () => null },
            body: { getReader: () => makeReader([[7]]) }
        }));

        lookupMock.mockResolvedValueOnce([{ address: "::ffff:8.8.8.8", family: 6 }]);
        await expect(resolveImageToBytes("https://example.com/mapped-dotted.png")).resolves.toEqual(Buffer.from([7]));

        lookupMock.mockResolvedValueOnce([{ address: "::ffff:0808:0808", family: 6 }]);
        await expect(resolveImageToBytes("https://example.com/mapped-hex.png")).resolves.toEqual(Buffer.from([7]));

        lookupMock.mockResolvedValueOnce([{ address: "::ffff:1:2:3", family: 6 }]);
        await expect(resolveImageToBytes("https://example.com/mapped-too-many-parts.png")).resolves.toEqual(Buffer.from([7]));

        lookupMock.mockResolvedValueOnce([{ address: "::ffff:zzzz:1", family: 6 }]);
        await expect(resolveImageToBytes("https://example.com/mapped-nan.png")).resolves.toEqual(Buffer.from([7]));

        lookupMock.mockResolvedValueOnce([{ address: "::ffff:10000:1", family: 6 }]);
        await expect(resolveImageToBytes("https://example.com/mapped-out-of-range.png")).resolves.toEqual(Buffer.from([7]));
    });

    it("resolveImageToBytes enforces content-length and streamed byte limits", async () => {
        configState.appConfig = { maxRemoteImageBytes: 2 };

        (globalThis as any).fetch = vi.fn(async () => ({
            ok: true,
            statusText: "OK",
            headers: { get: () => "3" },
            body: { getReader: () => makeReader([[1]]) }
        }));
        await expect(resolveImageToBytes("https://example.com/x.png")).rejects.toThrow("Could not resolve reference image");

        (globalThis as any).fetch = vi.fn(async () => ({
            ok: true,
            statusText: "OK",
            headers: { get: () => null },
            body: { getReader: () => makeReader([[1, 2], [3]]) }
        }));
        await expect(resolveImageToBytes("https://example.com/y.png")).rejects.toThrow("Could not resolve reference image");
    });

    it("resolveImageToBytes handles missing appConfig by using default limits", async () => {
        configGetMock.mockImplementationOnce(() => ({} as any));
        await expect(resolveImageToBytes("data:image/png;base64,QQ==")).resolves.toEqual(Buffer.from("A"));
    });

    it("resolveImageToBytes tolerates non-numeric content-length and skips empty stream chunks", async () => {
        (globalThis as any).fetch = vi.fn(async () => ({
            ok: true,
            statusText: "OK",
            headers: { get: () => "abc" },
            body: {
                getReader: () => ({
                    read: vi
                        .fn()
                        .mockResolvedValueOnce({ done: false, value: undefined })
                        .mockResolvedValueOnce({ done: false, value: Uint8Array.from([1, 2]) })
                        .mockResolvedValueOnce({ done: true, value: undefined })
                })
            }
        }));

        await expect(resolveImageToBytes("https://example.com/ok.png")).resolves.toEqual(Buffer.from([1, 2]));
    });

    it("resolveImageToBytes handles failed response and missing body reader", async () => {
        (globalThis as any).fetch = vi.fn(async () => ({ ok: false, statusText: "Not Found", headers: { get: () => null } }));
        await expect(resolveImageToBytes("https://example.com/a.png")).rejects.toThrow("Could not resolve reference image");

        (globalThis as any).fetch = vi.fn(async () => ({ ok: true, statusText: "OK", headers: { get: () => null }, body: {} }));
        await expect(resolveImageToBytes("https://example.com/b.png")).rejects.toThrow("Could not resolve reference image");
    });

    it("parseBestEffortJson handles full JSON, line json, adjacent objects, and fallback", () => {
        expect(parseBestEffortJson('{"a":1}')).toEqual([{ a: 1 }]);
        expect(parseBestEffortJson('[{"a":1}]')).toEqual([{ a: 1 }]);
        expect(parseBestEffortJson('{"a":1}\n{"b":2}')).toEqual([{ a: 1 }, { b: 2 }]);
        expect(parseBestEffortJson('{"a":1}{"b":2}')).toEqual([{ a: 1 }, { b: 2 }]);
        expect(parseBestEffortJson('{"a":1}{bad}')).toEqual([{ a: 1 }]);
        expect(parseBestEffortJson('not-json')).toEqual(["not-json"]);
        expect(parseBestEffortJson('   ')).toEqual([]);
    });

    it("validateNonNegativeInteger validates values", () => {
        expect(() => validateNonNegativeInteger(undefined, "x")).not.toThrow();
        expect(() => validateNonNegativeInteger(0, "x")).not.toThrow();
        expect(() => validateNonNegativeInteger(2, "x")).not.toThrow();
        expect(() => validateNonNegativeInteger(-1, "x")).toThrow("Invalid appConfig.x");
        expect(() => validateNonNegativeInteger(1.2, "x")).toThrow("Invalid appConfig.x");
    });

    it("expectArrayForCapability and expectObjectForCapability enforce types", () => {
        expect(expectArrayForCapability("chat", [1, 2], "input")).toEqual([1, 2]);
        expect(() => expectArrayForCapability("chat", {}, "input")).toThrow("Invalid input for capability 'chat'");

        expect(expectObjectForCapability("chat", { a: 1 }, "payload")).toEqual({ a: 1 });
        expect(() => expectObjectForCapability("chat", [1], "payload")).toThrow(
            "Invalid payload for capability 'chat'"
        );
        expect(() => expectObjectForCapability("chat", null, "payload")).toThrow(
            "Invalid payload for capability 'chat'"
        );
    });

    it("readNumber returns finite numeric values only", () => {
        expect(readNumber({ a: 1 }, "a")).toBe(1);
        expect(readNumber({ a: NaN }, "a")).toBeUndefined();
        expect(readNumber({ a: Infinity }, "a")).toBeUndefined();
        expect(readNumber({ a: "1" }, "a")).toBeUndefined();
        expect(readNumber({}, "a")).toBeUndefined();
    });
});
