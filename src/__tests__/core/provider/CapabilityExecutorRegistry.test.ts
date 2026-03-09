import { describe, expect, it, vi } from "vitest";
import {
    CapabilityExecutorRegistry,
    CapabilityKeys,
    createDefaultExecutors,
    MultiModalExecutionContext,
    type StreamingExecutor
} from "#root/index.js";

async function collect<T>(iter: AsyncGenerator<T>): Promise<T[]> {
    const out: T[] = [];
    for await (const item of iter) {
        out.push(item);
    }
    return out;
}

describe("CapabilityExecutorRegistry", () => {
    it("register/get/has/set/getExecutors work", () => {
        const registry = new CapabilityExecutorRegistry();
        const cap = "custom:cap";
        const nonStreaming = {
            streaming: false as const,
            invoke: vi.fn(async () => ({ output: "ok" }))
        };
        const streaming: StreamingExecutor<any, any, any> = {
            streaming: true as const,
            invoke: (async function* (_capability, _input, _ctx, _signal) {
                yield { output: "stream" } as any;
            }) as StreamingExecutor<any, any, any>["invoke"]
        };

        expect(registry.has(cap as any)).toBe(false);
        registry.register(cap as any, nonStreaming);
        expect(registry.has(cap as any)).toBe(true);
        expect(registry.get(cap as any)).toBe(nonStreaming);

        registry.set(cap as any, streaming);
        expect(registry.get(cap as any)).toBe(streaming);
        expect(registry.getExecutors().get(cap as any)).toBe(streaming);
    });

    it("register returns registry instance for chaining", () => {
        const registry = new CapabilityExecutorRegistry();
        const result = registry.register("custom:a" as any, {
            streaming: false as const,
            invoke: vi.fn(async () => ({ output: 1 }))
        });

        expect(result).toBe(registry);
        expect(registry.has("custom:a" as any)).toBe(true);
    });

    it("get throws when capability is not registered", () => {
        const registry = new CapabilityExecutorRegistry();
        expect(() => registry.get("missing:cap" as any)).toThrow("Capability 'missing:cap' not registered");
    });

    it("createDefaultExecutors registers all built-in capabilities with correct streaming flags", () => {
        const registry = createDefaultExecutors();

        expect(registry.get(CapabilityKeys.ChatCapabilityKey).streaming).toBe(false);
        expect(registry.get(CapabilityKeys.ChatStreamCapabilityKey).streaming).toBe(true);
        expect(registry.get(CapabilityKeys.AudioTranscriptionCapabilityKey).streaming).toBe(false);
        expect(registry.get(CapabilityKeys.AudioTranscriptionStreamCapabilityKey).streaming).toBe(true);
        expect(registry.get(CapabilityKeys.AudioTranslationCapabilityKey).streaming).toBe(false);
        expect(registry.get(CapabilityKeys.AudioTextToSpeechCapabilityKey).streaming).toBe(false);
        expect(registry.get(CapabilityKeys.AudioTextToSpeechStreamCapabilityKey).streaming).toBe(true);
        expect(registry.get(CapabilityKeys.VideoGenerationCapabilityKey).streaming).toBe(false);
        expect(registry.get(CapabilityKeys.VideoAnalysisCapabilityKey).streaming).toBe(false);
        expect(registry.get(CapabilityKeys.VideoDownloadCapabilityKey).streaming).toBe(false);
        expect(registry.get(CapabilityKeys.VideoExtendCapabilityKey).streaming).toBe(false);
        expect(registry.get(CapabilityKeys.VideoRemixCapabilityKey).streaming).toBe(false);
        expect(registry.get(CapabilityKeys.ImageGenerationCapabilityKey).streaming).toBe(false);
        expect(registry.get(CapabilityKeys.ImageGenerationStreamCapabilityKey).streaming).toBe(true);
        expect(registry.get(CapabilityKeys.ImageAnalysisCapabilityKey).streaming).toBe(false);
        expect(registry.get(CapabilityKeys.ImageAnalysisStreamCapabilityKey).streaming).toBe(true);
        expect(registry.get(CapabilityKeys.ImageEditCapabilityKey).streaming).toBe(false);
        expect(registry.get(CapabilityKeys.ImageEditStreamCapabilityKey).streaming).toBe(true);
        expect(registry.get(CapabilityKeys.EmbedCapabilityKey).streaming).toBe(false);
        expect(registry.get(CapabilityKeys.ModerationCapabilityKey).streaming).toBe(false);
        expect(registry.get(CapabilityKeys.ApprovalGateCapabilityKey).streaming).toBe(false);
        expect(registry.get(CapabilityKeys.SaveFileCapabilityKey).streaming).toBe(false);
    });

    it("default non-streaming executors call the mapped capability methods", async () => {
        const registry = createDefaultExecutors();
        const ctx = new MultiModalExecutionContext();
        const input = { input: {} } as any;

        const chat = vi.fn(async () => ({ output: "chat-ok" }));
        const image = vi.fn(async () => ({ output: "image-ok" }));
        const analysis = vi.fn(async () => ({ output: "analysis-ok" }));
        const edit = vi.fn(async () => ({ output: "edit-ok" }));
        const transcribeAudio = vi.fn(async () => ({ output: "transcribe-ok" }));
        const translateAudio = vi.fn(async () => ({ output: "translate-ok" }));
        const textToSpeech = vi.fn(async () => ({ output: "tts-ok" }));
        const generateVideo = vi.fn(async () => ({ output: "video-ok" }));
        const analyzeVideo = vi.fn(async () => ({ output: "video-analysis-ok" }));
        const downloadVideo = vi.fn(async () => ({ output: "video-download-ok" }));
        const extendVideo = vi.fn(async () => ({ output: "video-extend-ok" }));
        const remixVideo = vi.fn(async () => ({ output: "video-remix-ok" }));
        const embed = vi.fn(async () => ({ output: "embed-ok" }));
        const moderation = vi.fn(async () => ({ output: "moderation-ok" }));

        await registry.get(CapabilityKeys.ChatCapabilityKey).invoke({ chat } as any, input, ctx);
        await registry
            .get(CapabilityKeys.AudioTranscriptionCapabilityKey)
            .invoke({ transcribeAudio } as any, input, ctx);
        await registry
            .get(CapabilityKeys.AudioTranslationCapabilityKey)
            .invoke({ translateAudio } as any, input, ctx);
        await registry
            .get(CapabilityKeys.AudioTextToSpeechCapabilityKey)
            .invoke({ textToSpeech } as any, input, ctx);
        await registry.get(CapabilityKeys.VideoGenerationCapabilityKey).invoke({ generateVideo } as any, input, ctx);
        await registry.get(CapabilityKeys.VideoAnalysisCapabilityKey).invoke({ analyzeVideo } as any, input, ctx);
        await registry.get(CapabilityKeys.VideoDownloadCapabilityKey).invoke({ downloadVideo } as any, input, ctx);
        await registry.get(CapabilityKeys.VideoExtendCapabilityKey).invoke({ extendVideo } as any, input, ctx);
        await registry.get(CapabilityKeys.VideoRemixCapabilityKey).invoke({ remixVideo } as any, input, ctx);
        await registry.get(CapabilityKeys.ImageGenerationCapabilityKey).invoke({ generateImage: image } as any, input, ctx);
        await registry.get(CapabilityKeys.ImageAnalysisCapabilityKey).invoke({ analyzeImage: analysis } as any, input, ctx);
        await registry.get(CapabilityKeys.ImageEditCapabilityKey).invoke({ editImage: edit } as any, input, ctx);
        await registry.get(CapabilityKeys.EmbedCapabilityKey).invoke({ embed } as any, input, ctx);
        await registry.get(CapabilityKeys.ModerationCapabilityKey).invoke({ moderation } as any, input, ctx);

        expect(chat).toHaveBeenCalledTimes(1);
        expect(transcribeAudio).toHaveBeenCalledTimes(1);
        expect(translateAudio).toHaveBeenCalledTimes(1);
        expect(textToSpeech).toHaveBeenCalledTimes(1);
        expect(generateVideo).toHaveBeenCalledTimes(1);
        expect(analyzeVideo).toHaveBeenCalledTimes(1);
        expect(downloadVideo).toHaveBeenCalledTimes(1);
        expect(extendVideo).toHaveBeenCalledTimes(1);
        expect(remixVideo).toHaveBeenCalledTimes(1);
        expect(image).toHaveBeenCalledTimes(1);
        expect(analysis).toHaveBeenCalledTimes(1);
        expect(edit).toHaveBeenCalledTimes(1);
        expect(embed).toHaveBeenCalledTimes(1);
        expect(moderation).toHaveBeenCalledTimes(1);
    });

    it("default streaming executors call mapped stream methods and yield chunks", async () => {
        const registry = createDefaultExecutors();
        const ctx = new MultiModalExecutionContext();
        const input = { input: {} } as any;

        const chatStream = vi.fn(async function* () {
            yield { delta: "c1" };
        });
        const imageStream = vi.fn(async function* () {
            yield { delta: "i1" };
        });
        const analysisStream = vi.fn(async function* () {
            yield { delta: "a1" };
        });
        const editStream = vi.fn(async function* () {
            yield { delta: "e1" };
        });
        const audioTranscriptionStream = vi.fn(async function* () {
            yield { delta: "t1" };
        });
        const audioTtsStream = vi.fn(async function* () {
            yield { delta: "s1" };
        });

        const chatExec = registry.get(CapabilityKeys.ChatStreamCapabilityKey) as StreamingExecutor<any, any, any>;
        const imageExec = registry.get(CapabilityKeys.ImageGenerationStreamCapabilityKey) as StreamingExecutor<any, any, any>;
        const analysisExec = registry.get(CapabilityKeys.ImageAnalysisStreamCapabilityKey) as StreamingExecutor<any, any, any>;
        const editExec = registry.get(CapabilityKeys.ImageEditStreamCapabilityKey) as StreamingExecutor<any, any, any>;
        const audioTranscriptionExec = registry.get(
            CapabilityKeys.AudioTranscriptionStreamCapabilityKey
        ) as StreamingExecutor<any, any, any>;
        const audioTtsExec = registry.get(CapabilityKeys.AudioTextToSpeechStreamCapabilityKey) as StreamingExecutor<
            any,
            any,
            any
        >;

        const chatChunks = await collect(chatExec.invoke({ chatStream } as any, input, ctx));
        const imageChunks = await collect(imageExec.invoke({ generateImageStream: imageStream } as any, input, ctx));
        const analysisChunks = await collect(analysisExec.invoke({ analyzeImageStream: analysisStream } as any, input, ctx));
        const editChunks = await collect(editExec.invoke({ editImageStream: editStream } as any, input, ctx));
        const transcriptionChunks = await collect(
            audioTranscriptionExec.invoke({ transcribeAudioStream: audioTranscriptionStream } as any, input, ctx)
        );
        const ttsChunks = await collect(audioTtsExec.invoke({ textToSpeechStream: audioTtsStream } as any, input, ctx));

        expect(chatStream).toHaveBeenCalledTimes(1);
        expect(imageStream).toHaveBeenCalledTimes(1);
        expect(analysisStream).toHaveBeenCalledTimes(1);
        expect(editStream).toHaveBeenCalledTimes(1);
        expect(audioTranscriptionStream).toHaveBeenCalledTimes(1);
        expect(audioTtsStream).toHaveBeenCalledTimes(1);
        expect(chatChunks).toEqual([{ delta: "c1" }]);
        expect(imageChunks).toEqual([{ delta: "i1" }]);
        expect(analysisChunks).toEqual([{ delta: "a1" }]);
        expect(editChunks).toEqual([{ delta: "e1" }]);
        expect(transcriptionChunks).toEqual([{ delta: "t1" }]);
        expect(ttsChunks).toEqual([{ delta: "s1" }]);
    });
});
