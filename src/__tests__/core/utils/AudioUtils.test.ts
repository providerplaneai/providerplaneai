import { describe, expect, it, vi } from "vitest";
import { createAudioArtifact } from "#root/core/utils/AudioUtils.js";

describe("AudioUtils", () => {
    it("createAudioArtifact includes supported optional fields", () => {
        const full = createAudioArtifact({
            id: "a1",
            kind: "tts",
            mimeType: "audio/wav",
            url: "https://cdn.example.com/a.wav",
            base64: "AQID",
            transcript: "hello",
            durationSeconds: 1.25,
            sampleRateHz: 24000,
            channels: 1,
            bitrate: 128000,
            raw: { provider: "x" }
        });

        expect(full.id).toBe("a1");
        expect(full.kind).toBe("tts");
        expect(full.url).toBe("https://cdn.example.com/a.wav");
        expect(full.base64).toBe("AQID");
        expect(full.transcript).toBe("hello");
        expect(full.durationSeconds).toBe(1.25);
        expect(full.sampleRateHz).toBe(24000);
        expect(full.channels).toBe(1);
        expect(full.bitrate).toBe(128000);
        expect(full.raw).toEqual({ provider: "x" });

        const minimal = createAudioArtifact({ mimeType: "audio/mpeg" });
        expect(typeof minimal.id).toBe("string");
        expect(minimal.mimeType).toBe("audio/mpeg");
        expect(minimal.url).toBeUndefined();
        expect(minimal.base64).toBeUndefined();
        expect(minimal.transcript).toBeUndefined();
    });

    it("createAudioArtifact omits empty optional string values", () => {
        const artifact = createAudioArtifact({
            mimeType: "audio/wav",
            url: "",
            base64: "",
            transcript: ""
        });

        expect(artifact.url).toBeUndefined();
        expect(artifact.base64).toBeUndefined();
        expect(artifact.transcript).toBeUndefined();
    });

    it("createAudioArtifact generates id when none is provided", () => {
        const uuidSpy = vi.spyOn(crypto, "randomUUID").mockReturnValue("generated-id");
        try {
            const artifact = createAudioArtifact({ mimeType: "audio/mpeg" });
            expect(artifact.id).toBe("generated-id");
        } finally {
            uuidSpy.mockRestore();
        }
    });
});
