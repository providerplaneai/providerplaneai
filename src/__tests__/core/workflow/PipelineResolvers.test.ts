import { describe, expect, it } from "vitest";
import {
    PipelineError,
    extractPipelineAudioArtifact,
    extractPipelineImageReference,
    extractPipelineText,
    resolvePipelineTemplate,
    toPipelineFileInput,
    toPipelineAudioInput
} from "#root/index.js";

describe("PipelineResolvers", () => {
    it("extractPipelineText collects text from nested mixed payloads and deduplicates", () => {
        const payload = {
            outputText: "alpha",
            content: [{ type: "text", text: "beta" }, { type: "text", text: "beta" }],
            response: {
                candidates: [
                    {
                        content: {
                            parts: [{ text: "gamma" }]
                        }
                    }
                ]
            },
            nested: {
                description: "delta",
                transcript: "epsilon"
            }
        };

        const text = extractPipelineText(payload);
        expect(text).toContain("alpha");
        expect(text).toContain("beta");
        expect(text).toContain("gamma");
        expect(text).toContain("delta");
        expect(text).toContain("epsilon");
        expect(text.split("\n").filter((x) => x === "beta")).toHaveLength(1);
    });

    it("extractPipelineText handles cyclic objects safely", () => {
        const cyclic: Record<string, unknown> = { message: "hello" };
        cyclic.self = cyclic;
        expect(extractPipelineText(cyclic)).toContain("hello");
    });

    it("resolvePipelineTemplate resolves known tokens and blanks unknown tokens", () => {
        const out = resolvePipelineTemplate("A={{a}} B={{missing}} C={{ c }}", {
            a: { text: "one" },
            c: "two"
        });
        expect(out).toBe("A=one B= C=two");
    });

    it("resolvePipelineTemplate blanks empty placeholder tokens", () => {
        expect(resolvePipelineTemplate("A={{   }} B={{value}}", { value: { text: "ok" } })).toBe("A= B=ok");
    });

    it("extractPipelineImageReference prefers base64 and supports url fallback", () => {
        const base64Ref = extractPipelineImageReference([{ id: "i1", mimeType: "image/png", base64: "AQID" }]);
        expect(base64Ref).toEqual({
            id: "i1",
            sourceType: "base64",
            base64: "AQID",
            mimeType: "image/png"
        });

        const urlRef = extractPipelineImageReference([{ id: "i2", url: "https://example.com/i2.png" }]);
        expect(urlRef).toEqual({
            id: "i2",
            sourceType: "url",
            url: "https://example.com/i2.png"
        });
    });

    it("extractPipelineImageReference throws PipelineError for invalid payloads", () => {
        expect(() => extractPipelineImageReference(undefined)).toThrow(PipelineError);
        expect(() => extractPipelineImageReference([{ id: "bad" }])).toThrow("missing both base64 and url");
    });

    it("extractPipelineAudioArtifact returns first object and throws on invalid values", () => {
        const audio = extractPipelineAudioArtifact([{ id: "a1", mimeType: "audio/mpeg", base64: "QQ==" }]);
        expect(audio).toMatchObject({ id: "a1", mimeType: "audio/mpeg", base64: "QQ==" });

        expect(() => extractPipelineAudioArtifact(undefined)).toThrow(PipelineError);
        expect(() => extractPipelineAudioArtifact("not-object")).toThrow("no audio artifact");
    });

    it("toPipelineAudioInput prefers base64 data URL and falls back to URL", () => {
        expect(toPipelineAudioInput({ mimeType: "audio/wav", base64: "AQID" })).toBe("data:audio/wav;base64,AQID");
        expect(toPipelineAudioInput({ url: "https://example.com/audio.mp3" })).toBe("https://example.com/audio.mp3");
    });

    it("toPipelineAudioInput throws PipelineError when no base64/url is present", () => {
        expect(() => toPipelineAudioInput({ mimeType: "audio/mpeg" })).toThrow(PipelineError);
        expect(() => toPipelineAudioInput({})).toThrow("missing both base64 and url");
    });

    it("toPipelineFileInput prefers base64 data URL and falls back to URL", () => {
        expect(toPipelineFileInput({ mimeType: "application/pdf", base64: "JVBERg==" })).toBe(
            "data:application/pdf;base64,JVBERg=="
        );
        expect(toPipelineFileInput({ url: "https://example.com/doc.pdf" })).toBe("https://example.com/doc.pdf");
    });

    it("toPipelineFileInput throws PipelineError when no base64/url is present", () => {
        expect(() => toPipelineFileInput({ mimeType: "application/pdf" })).toThrow(PipelineError);
        expect(() => toPipelineFileInput({})).toThrow("missing both base64 and url");
    });

    it("extractPipelineText handles nested text value objects and non-object roots", () => {
        expect(
            extractPipelineText({
                content: [{ type: "output_text", text: { value: "nested text" } }],
                summary: "summary text"
            })
        ).toContain("nested text");
        expect(extractPipelineText(42)).toBe("");
    });
});
