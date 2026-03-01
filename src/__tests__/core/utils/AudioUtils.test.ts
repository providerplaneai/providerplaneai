import { describe, expect, it, vi } from "vitest";
import {
    assertAudioBytesWithinLimit,
    createAudioArtifact,
    decodeBase64Audio,
    extractAudioMimeInfo,
    resolveAudioInputMimeType,
    resolveAudioOutputMimeType
} from "#root/core/utils/AudioUtils.js";

describe("AudioUtils", () => {
    it("createAudioArtifact includes only provided optional fields", () => {
        const full = createAudioArtifact({
            id: "a1",
            kind: "tts",
            mimeType: "audio/wav",
            url: "https://cdn.example.com/a.wav",
            base64: "AQID",
            durationSeconds: 1.25,
            language: "en",
            transcript: "hello",
            segments: [{ text: "hello" }],
            words: [{ word: "hello" }],
            sampleRateHz: 24000,
            channels: 1,
            bitrate: 128000,
            raw: { provider: "x" }
        });

        expect(full.id).toBe("a1");
        expect(full.kind).toBe("tts");
        expect(full.url).toBe("https://cdn.example.com/a.wav");
        expect(full.base64).toBe("AQID");
        expect(full.language).toBe("en");
        expect(full.sampleRateHz).toBe(24000);

        const minimal = createAudioArtifact({ mimeType: "audio/mpeg" });
        expect(typeof minimal.id).toBe("string");
        expect(minimal.mimeType).toBe("audio/mpeg");
        expect(minimal.url).toBeUndefined();
        expect(minimal.base64).toBeUndefined();
        expect(minimal.transcript).toBeUndefined();
    });

    it("extractAudioMimeInfo parses aliases and ignores invalid params", () => {
        expect(extractAudioMimeInfo(undefined)).toEqual({});
        expect(extractAudioMimeInfo("audio/wav")).toEqual({
            sampleRateHz: undefined,
            channels: undefined,
            bitrate: undefined
        });

        expect(extractAudioMimeInfo("audio/L16;rate=24000;channels=1;bitrate=96000")).toEqual({
            sampleRateHz: 24000,
            channels: 1,
            bitrate: 96000
        });

        expect(extractAudioMimeInfo("audio/wav;samplerate=48000;channelcount=2")).toEqual({
            sampleRateHz: 48000,
            channels: 2,
            bitrate: undefined
        });

        expect(extractAudioMimeInfo("audio/wav;badparam;rate=abc")).toEqual({
            sampleRateHz: undefined,
            channels: undefined,
            bitrate: undefined
        });
    });

    it("resolveAudioInputMimeType follows precedence and extension mapping", () => {
        expect(resolveAudioInputMimeType("any", "audio/flac")).toBe("audio/flac");
        expect(resolveAudioInputMimeType({ type: "audio/ogg" })).toBe("audio/ogg");
        expect(resolveAudioInputMimeType("a.wav")).toBe("audio/wav");
        expect(resolveAudioInputMimeType("a.flac")).toBe("audio/flac");
        expect(resolveAudioInputMimeType("a.aac")).toBe("audio/aac");
        expect(resolveAudioInputMimeType("a.opus")).toBe("audio/opus");
        expect(resolveAudioInputMimeType("a.ogg")).toBe("audio/ogg");
        expect(resolveAudioInputMimeType("a.pcm")).toBe("audio/pcm");
        expect(resolveAudioInputMimeType({ name: "track.wav" })).toBe("audio/wav");
        expect(resolveAudioInputMimeType("unknown.ext")).toBe("audio/mpeg");
    });

    it("resolveAudioOutputMimeType resolves from header or requested format", () => {
        expect(resolveAudioOutputMimeType("mp3", "audio/ogg; charset=utf-8")).toBe("audio/ogg");
        expect(resolveAudioOutputMimeType("wav", null)).toBe("audio/wav");
        expect(resolveAudioOutputMimeType("flac", null)).toBe("audio/flac");
        expect(resolveAudioOutputMimeType("aac", null)).toBe("audio/aac");
        expect(resolveAudioOutputMimeType("opus", null)).toBe("audio/opus");
        expect(resolveAudioOutputMimeType("pcm", null)).toBe("audio/pcm");
        expect(resolveAudioOutputMimeType("mp3", null)).toBe("audio/mpeg");
        expect(resolveAudioOutputMimeType(undefined, null, "mp3")).toBe("audio/mpeg");
    });

    it("assertAudioBytesWithinLimit allows disabled/within and throws when exceeded", () => {
        expect(() => assertAudioBytesWithinLimit(10, undefined, "t")).not.toThrow();
        expect(() => assertAudioBytesWithinLimit(10, Number.NaN, "t")).not.toThrow();
        expect(() => assertAudioBytesWithinLimit(10, 0, "t")).not.toThrow();
        expect(() => assertAudioBytesWithinLimit(10, -1, "t")).not.toThrow();
        expect(() => assertAudioBytesWithinLimit(10, 10, "t")).not.toThrow();
        expect(() => assertAudioBytesWithinLimit(9, 10, "t")).not.toThrow();

        expect(() => assertAudioBytesWithinLimit(11, 10, "tts")).toThrow("[AUDIO_OUTPUT_TOO_LARGE]");
    });

    it("decodeBase64Audio validates empty and malformed payloads", () => {
        expect(() => decodeBase64Audio("", "source-a")).toThrow("[AUDIO_EMPTY_RESPONSE]");
        expect(() => decodeBase64Audio("=", "source-b")).toThrow("[AUDIO_INVALID_PAYLOAD]");
        expect(() => decodeBase64Audio("AQ=I", "source-b2")).toThrow("[AUDIO_INVALID_PAYLOAD]");

        const bytes = decodeBase64Audio("AQID", "source-c");
        expect(Buffer.from(bytes).toString("base64")).toBe("AQID");
        const spaced = decodeBase64Audio("AQI D\n", "source-d");
        expect(Buffer.from(spaced).toString("base64")).toBe("AQID");
    });

    it("decodeBase64Audio surfaces AUDIO_INVALID_PAYLOAD if base64 decode throws", () => {
        const fromSpy = vi.spyOn(Buffer, "from").mockImplementationOnce(() => {
            throw new Error("decode failed");
        });

        try {
            expect(() => decodeBase64Audio("AQID", "source-x")).toThrow("[AUDIO_INVALID_PAYLOAD]");
        } finally {
            fromSpy.mockRestore();
        }
    });
});
