import { describe, expect, it, vi } from "vitest";
import { OpenAIAudioTextToSpeechCapabilityImpl } from "#root/providers/openai/capabilities/OpenAIAudioTextToSpeechCapabilityImpl.js";
import { OpenAIAudioTranscriptionCapabilityImpl } from "#root/providers/openai/capabilities/OpenAIAudioTranscriptionCapabilityImpl.js";
import { OpenAIAudioTranslationCapabilityImpl } from "#root/providers/openai/capabilities/OpenAIAudioTranslationCapabilityImpl.js";
import { GeminiAudioTextToSpeechCapabilityImpl } from "#root/providers/gemini/capabilities/GeminiAudioTextToSpeechCapabilityImpl.js";
import { GeminiAudioTranscriptionCapabilityImpl } from "#root/providers/gemini/capabilities/GeminiAudioTranscriptionCapabilityImpl.js";
import { GeminiAudioTranslationCapabilityImpl } from "#root/providers/gemini/capabilities/GeminiAudioTranslationCapabilityImpl.js";

function makeProvider(defaults?: Record<string, unknown>) {
    return {
        ensureInitialized: vi.fn(),
        getMergedOptions: vi.fn((_capability: string, runtimeOptions: any) => ({
            model: runtimeOptions?.model,
            modelParams: {},
            providerParams: {},
            generalParams: {
                audioStreamBatchSize: 2,
                ...(defaults ?? {}),
                ...(runtimeOptions?.generalParams ?? {})
            }
        }))
    } as any;
}

async function collect<T>(iter: AsyncGenerator<T>): Promise<T[]> {
    const out: T[] = [];
    for await (const item of iter) {
        out.push(item);
    }
    return out;
}

describe("Audio capability cross-provider contract", () => {
    it("transcription returns normalized assistant chat text across providers", async () => {
        const openai = new OpenAIAudioTranscriptionCapabilityImpl(
            makeProvider(),
            {
                audio: {
                    transcriptions: {
                        create: vi.fn().mockResolvedValue({ text: "openai transcript" })
                    }
                }
            } as any
        );

        const gemini = new GeminiAudioTranscriptionCapabilityImpl(
            makeProvider(),
            {
                models: {
                    generateContent: vi.fn().mockResolvedValue({ text: "gemini transcript", responseId: "g1" })
                }
            } as any
        );

        const openaiRes = await openai.transcribeAudio({ input: { file: Buffer.from("abc") } } as any, {} as any);
        const geminiRes = await gemini.transcribeAudio({ input: { file: Buffer.from("abc") } } as any, {} as any);

        expect(openaiRes.output[0]?.role).toBe("assistant");
        expect(geminiRes.output[0]?.role).toBe("assistant");
        expect(openaiRes.output[0]?.content?.[0]).toEqual({ type: "text", text: "openai transcript" });
        expect(geminiRes.output[0]?.content?.[0]).toEqual({ type: "text", text: "gemini transcript" });
    });

    it("translation returns normalized assistant chat text across providers", async () => {
        const openai = new OpenAIAudioTranslationCapabilityImpl(
            makeProvider(),
            {
                audio: {
                    translations: {
                        create: vi.fn().mockResolvedValue({ id: "o_tr_1", text: "hello world" })
                    }
                }
            } as any
        );

        const gemini = new GeminiAudioTranslationCapabilityImpl(
            makeProvider(),
            {
                models: {
                    generateContent: vi.fn().mockResolvedValue({ text: "hello world", responseId: "g_tr_1" })
                }
            } as any
        );

        const openaiRes = await openai.translateAudio(
            { input: { file: Buffer.from("abc"), targetLanguage: "en" } } as any,
            {} as any
        );
        const geminiRes = await gemini.translateAudio(
            { input: { file: Buffer.from("abc"), targetLanguage: "en" } } as any,
            {} as any
        );

        expect(openaiRes.output[0]?.content?.[0]).toEqual({ type: "text", text: "hello world" });
        expect(geminiRes.output[0]?.content?.[0]).toEqual({ type: "text", text: "hello world" });
    });

    it("tts stream returns terminal error chunk shape across providers when payload is unavailable", async () => {
        const openai = new OpenAIAudioTextToSpeechCapabilityImpl(
            makeProvider(),
            {
                audio: {
                    speech: {
                        create: vi.fn().mockResolvedValue({
                            id: "o_tts_stream",
                            headers: { get: vi.fn().mockReturnValue("audio/mpeg") }
                        })
                    }
                }
            } as any
        );

        const gemini = new GeminiAudioTextToSpeechCapabilityImpl(
            makeProvider(),
            {
                models: {
                    generateContentStream: vi.fn().mockResolvedValue({
                        async *[Symbol.asyncIterator]() {
                            yield { responseId: "g_tts_stream", candidates: [{ content: { parts: [{ text: "no-audio" }] } }] };
                        }
                    })
                }
            } as any
        );

        const openaiChunks = await collect(openai.textToSpeechStream({ input: { text: "hello", format: "mp3" } } as any, {} as any));
        const geminiChunks = await collect(gemini.textToSpeechStream({ input: { text: "hello", format: "wav" } } as any, {} as any));

        const openaiFinal = openaiChunks.at(-1);
        const geminiFinal = geminiChunks.at(-1);

        expect(openaiFinal?.done).toBe(true);
        expect(geminiFinal?.done).toBe(true);
        expect(openaiFinal?.output).toEqual([]);
        expect(geminiFinal?.output).toEqual([]);
        expect(openaiFinal?.metadata?.status).toBe("error");
        expect(geminiFinal?.metadata?.status).toBe("error");
    });
});
