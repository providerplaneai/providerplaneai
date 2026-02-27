import { describe, expect, it } from "vitest";
import { MultiModalExecutionContext } from "#root/core/types/MultiModalExecutionContext.js";

class TestContext extends MultiModalExecutionContext {
    pushEvent(event: any) {
        (this as any).timeline.push(event);
    }
}

describe("MultiModalExecutionContext", () => {
    it("begins a turn and records userMessage event", () => {
        const ctx = new MultiModalExecutionContext();
        ctx.beginTurn({ id: "u1", modality: "chat", input: "hello" });

        const timeline = ctx.getTimeline();
        expect(timeline).toHaveLength(1);
        expect(timeline[0].type).toBe("userMessage");
        expect((timeline[0] as any).message.input).toBe("hello");
    });

    it("applyAssistantMessage records assistant event and latest chat", () => {
        const ctx = new MultiModalExecutionContext();
        const msg = { id: "a1", role: "assistant", content: [{ type: "text", text: "hi" }] };
        ctx.applyAssistantMessage(msg as any);

        expect(ctx.getTimeline()).toHaveLength(1);
        expect(ctx.getTimeline()[0].type).toBe("assistantMessage");
        expect(ctx.getLatestChat()).toEqual([msg]);
    });

    it("attachArtifacts records systemEvent and updates latest artifact getters", () => {
        const ctx = new MultiModalExecutionContext();
        const image = { id: "img1", mimeType: "image/png", url: "x" };
        const embedding = { id: "e1", vector: [1, 2], dimensions: 2 };

        ctx.attachArtifacts({ images: [image] as any, embeddings: [embedding] as any });

        expect(ctx.getTimeline()).toHaveLength(1);
        expect(ctx.getTimeline()[0].type).toBe("systemEvent");
        expect((ctx.getTimeline()[0] as any).action).toBe("attachArtifacts");
        expect(ctx.getLatestImages()).toEqual([image]);
        expect(ctx.getLatestEmbeddings()).toEqual([embedding]);
    });

    it("returns latest masks and moderation from populated artifacts", () => {
        const ctx = new MultiModalExecutionContext();
        const mask = { id: "m1", mimeType: "image/png", url: "mask-url" };
        const moderation = { id: "mod1", flagged: false };

        ctx.attachArtifacts({ masks: [mask] as any, moderation: [moderation] as any });

        expect(ctx.getLatestMasks()).toEqual([mask]);
        expect(ctx.getLatestModeration()).toEqual([moderation]);
    });

    it("attachArtifacts handles undefined and normalizes non-array artifact fields", () => {
        const ctx = new MultiModalExecutionContext();

        ctx.attachArtifacts(undefined);
        expect(ctx.getTimeline()).toHaveLength(1);
        const emptyArtifacts = (ctx.getTimeline()[0] as any).artifacts;
        expect(emptyArtifacts.chat).toEqual([]);
        expect(emptyArtifacts.custom).toEqual([]);

        ctx.attachArtifacts({ images: "invalid" as any, audio: [{ id: "aud1", url: "a" }] as any });
        expect(ctx.getTimeline()).toHaveLength(2);
        expect(ctx.getLatestImages()).toEqual([]);
        expect(ctx.getLatestAudio()).toEqual([{ id: "aud1", url: "a" }]);
    });

    it("attachArtifactsFromResponse merges response artifacts and extra artifacts with metadata", () => {
        const ctx = new MultiModalExecutionContext();
        const fromResponse = { id: "img1", mimeType: "image/png", url: "a" };
        const extra = { id: "img2", mimeType: "image/png", url: "b" };

        ctx.attachArtifactsFromResponse(
            {
                output: "ok",
                multimodalArtifacts: { images: [fromResponse] as any },
                metadata: { provider: "openai", requestId: "r1" }
            },
            { images: [extra] as any }
        );

        const evt = ctx.getTimeline()[0] as any;
        expect(evt.type).toBe("systemEvent");
        expect(evt.metadata.provider).toBe("openai");
        expect(ctx.getLatestImages()).toEqual([fromResponse, extra]);
    });

    it("attachArtifactsFromResponse uses response artifacts when extras are omitted", () => {
        const ctx = new MultiModalExecutionContext();
        const file = { id: "f1", name: "doc.txt", mimeType: "text/plain" };
        const video = { id: "v1", mimeType: "video/mp4", url: "v" };

        ctx.attachArtifactsFromResponse({
            output: "ok",
            multimodalArtifacts: { files: [file] as any, video: [video] as any },
            metadata: { requestId: "req-1" }
        });

        expect(ctx.getLatestFile()).toEqual([file]);
        expect(ctx.getLatestVideo()).toEqual([video]);
        expect((ctx.getTimeline()[0] as any).metadata.requestId).toBe("req-1");
    });

    it("yieldArtifacts no-ops for undefined and records streamChunk event when provided", () => {
        const ctx = new MultiModalExecutionContext();
        ctx.yieldArtifacts(undefined);
        expect(ctx.getTimeline()).toHaveLength(0);

        const analysis = { id: "a1", description: "desc" };
        ctx.yieldArtifacts({ analysis: [analysis] as any });

        expect(ctx.getTimeline()).toHaveLength(1);
        expect((ctx.getTimeline()[0] as any).action).toBe("streamChunk");
        expect(ctx.getLatestAnalysis()).toEqual([analysis]);
    });

    it("reset clears timeline and latest getters return empty arrays", () => {
        const ctx = new MultiModalExecutionContext();
        ctx.beginTurn({ id: "u1", modality: "chat", input: "x" });
        ctx.attachArtifacts({ images: [{ id: "img", mimeType: "image/png", url: "x" }] as any });
        expect(ctx.getTimeline().length).toBeGreaterThan(0);

        ctx.reset();

        expect(ctx.getTimeline()).toEqual([]);
        expect(ctx.getLatestChat()).toEqual([]);
        expect(ctx.getLatestImages()).toEqual([]);
        expect(ctx.getLatestMasks()).toEqual([]);
        expect(ctx.getLatestAnalysis()).toEqual([]);
        expect(ctx.getLatestEmbeddings()).toEqual([]);
        expect(ctx.getLatestModeration()).toEqual([]);
        expect(ctx.getLatestAudio()).toEqual([]);
        expect(ctx.getLatestVideo()).toEqual([]);
        expect(ctx.getLatestFile()).toEqual([]);
    });

    it("getLatestImageGeneration and getLatestImageEdit return latest matching typed events", () => {
        const ctx = new TestContext();
        const gen = { id: "g1", type: "imageGeneration", timestamp: 1, artifacts: {} };
        const edit = { id: "e1", type: "imageEdit", timestamp: 2, artifacts: {} };
        ctx.pushEvent(gen);
        ctx.pushEvent(edit);

        expect(ctx.getLatestImageGeneration()).toEqual(gen);
        expect(ctx.getLatestImageEdit()).toEqual(edit);
    });

    it("returns undefined for image generation/edit when none exist", () => {
        const ctx = new TestContext();
        ctx.pushEvent({ id: "u1", type: "userMessage", timestamp: 1, artifacts: {} });

        expect(ctx.getLatestImageGeneration()).toBeUndefined();
        expect(ctx.getLatestImageEdit()).toBeUndefined();
    });
});
