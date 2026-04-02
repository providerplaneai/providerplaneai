import { describe, expect, it } from "vitest";
import dotenv from "dotenv";
import { readFile } from "node:fs/promises";
import {
    AIProvider,
    MistralProvider,
    MultiModalExecutionContext,
    type ProviderConnectionConfig
} from "#root/index.js";

dotenv.config({ quiet: true });

const RUN_LIVE_INTEGRATION = process.env.RUN_LIVE_INTEGRATION === "1";
const REQUIRED_ENV_VARS = ["MISTRAL_API_KEY_1"] as const;
const MISTRAL_TEST_VOICE_ID = "60844938-221d-4d1e-8233-34203f787d9f";

function missingRequiredEnvVars(): string[] {
    const missing: string[] = [];
    for (const key of REQUIRED_ENV_VARS) {
        if (!process.env[key] || process.env[key]?.trim().length === 0) {
            missing.push(key);
        }
    }
    return missing;
}

const hasProviderKeys = missingRequiredEnvVars().length === 0;
const describeMistralLive = RUN_LIVE_INTEGRATION && hasProviderKeys ? describe : describe.skip;
const MISTRAL_RATE_LIMIT_RETRY_DELAYS_MS = [65000] as const;

function isMistralRateLimitError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error ?? "");
    return message.includes("Status 429") || message.includes("rate_limited") || message.includes("Rate limit exceeded");
}

async function retryOnMistralRateLimit<T>(operation: () => Promise<T>): Promise<T> {
    let lastError: unknown;

    for (let attempt = 0; attempt <= MISTRAL_RATE_LIMIT_RETRY_DELAYS_MS.length; attempt += 1) {
        try {
            return await operation();
        } catch (error) {
            lastError = error;
            if (!isMistralRateLimitError(error) || attempt === MISTRAL_RATE_LIMIT_RETRY_DELAYS_MS.length) {
                throw error;
            }

            await new Promise((resolve) => setTimeout(resolve, MISTRAL_RATE_LIMIT_RETRY_DELAYS_MS[attempt]));
        }
    }

    throw lastError;
}

function createMistralProvider(): MistralProvider {
    const provider = new MistralProvider();
    const config: ProviderConnectionConfig = {
        type: AIProvider.Mistral,
        apiKeyEnvVar: "MISTRAL_API_KEY_1",
        apiKey: process.env.MISTRAL_API_KEY_1,
        defaultModel: "mistral-small-latest",
        defaultModels: {
            chat: "mistral-small-latest",
            chatStream: "mistral-small-latest",
            embed: "mistral-embed",
            moderation: "mistral-moderation-latest",
            imageAnalysis: "mistral-small-latest",
            imageAnalysisStream: "mistral-small-latest",
            ocr: "mistral-ocr-latest",
            audioTranscription: "voxtral-mini-latest",
            audioTranscriptionStream: "voxtral-mini-latest",
            audioTts: "voxtral-mini-tts-2603",
            audioTtsStream: "voxtral-mini-tts-2603"
        },
        models: {
            "mistral-small-latest": {
                chat: {},
                stream: {},
                imageAnalysis: {}
            },
            "mistral-ocr-latest": {
                ocr: {}
            },
            "mistral-embed": {
                embedding: {}
            },
            "mistral-moderation-latest": {
                moderation: {}
            },
            "voxtral-mini-latest": {
                audioTranscription: {},
                audioTranscriptionStream: {}
            },
            "voxtral-mini-tts-2603": {
                audioTts: {},
                audioTtsStream: {}
            }
        }
    };

    provider.init(config);
    return provider;
}

async function loadCybercatBase64(): Promise<string> {
    const bytes = await readFile(new URL("../../../../test_data/test_cybercat.png", import.meta.url));
    return bytes.toString("base64");
}

describeMistralLive("Mistral live integration", () => {
    it("streams chat responses end to end", async () => {
        const provider = createMistralProvider();
        const ctx = new MultiModalExecutionContext();
        const chunks: string[] = [];
        let sawIncompleteChunk = false;
        let finalText = "";

        for await (const chunk of provider.chatStream(
            {
                input: {
                    messages: [
                        {
                            role: "user",
                            content: [
                                {
                                    type: "text",
                                    text: "Reply with exactly this lowercase phrase and nothing else: alpha beta gamma delta"
                                }
                            ]
                        }
                    ]
                },
                options: {
                    generalParams: { chatStreamBatchSize: 8 }
                },
                context: { requestId: "mistral-live-stream" }
            },
            ctx
        )) {
            const deltaText = chunk.delta?.content
                ?.filter((part) => part.type === "text")
                .map((part) => part.text)
                .join("") ?? "";

            if (!chunk.done) {
                sawIncompleteChunk = true;
            }
            if (deltaText.length > 0) {
                chunks.push(deltaText);
            }

            finalText =
                chunk.output?.content
                    ?.filter((part) => part.type === "text")
                    .map((part) => part.text)
                    .join("") ?? finalText;
        }

        expect(chunks.length).toBeGreaterThan(0);
        expect(finalText.toLowerCase()).toContain("alpha");
        expect(finalText.toLowerCase()).toContain("gamma");
        expect(sawIncompleteChunk || chunks.length >= 1).toBe(true);
    });

    it("moderates batched inputs end to end", async () => {
        const provider = createMistralProvider();
        const response = await provider.moderation(
            {
                input: {
                    input: ["I enjoy sunny walks in the park.", "I want to kill everyone in this building."]
                },
                context: { requestId: "mistral-live-moderation-batch" }
            },
            new MultiModalExecutionContext()
        );

        expect(response.output).toHaveLength(2);
        expect(response.output.map((item) => item.inputIndex)).toEqual([0, 1]);
        expect(Object.keys(response.output[0]?.categories ?? {}).length).toBeGreaterThan(0);
        expect(response.output[1]?.flagged).toBe(true);
    });

    it("embeds batched inputs end to end", async () => {
        const provider = createMistralProvider();
        const response = await provider.embed(
            {
                input: {
                    input: ["providerplane embedding smoke test", "mistral embedding smoke test"],
                    purpose: "search"
                },
                context: { requestId: "mistral-live-embed-batch" }
            },
            new MultiModalExecutionContext()
        );

        expect(response.output).toHaveLength(2);
        expect(response.output.every((item) => Array.isArray(item.vector) && item.vector.length > 0)).toBe(true);
        expect(response.output.every((item) => item.dimensions === item.vector.length)).toBe(true);
        expect(
            response.output.every(
                (item) => item.metadata?.provider === AIProvider.Mistral && item.metadata?.status === "completed"
            )
        ).toBe(true);
        expect(response.metadata?.provider).toBe(AIProvider.Mistral);
    });

    it(
        "analyzes a local PNG image end to end",
        async () => {
            const provider = createMistralProvider();
            const base64 = await loadCybercatBase64();

            const response = await retryOnMistralRateLimit(() =>
                provider.analyzeImage(
                    {
                        input: {
                            prompt: "Describe the main subject of this image and return concise tags.",
                            images: [
                                {
                                    id: "cybercat",
                                    sourceType: "base64",
                                    base64,
                                    mimeType: "image/png"
                                }
                            ]
                        },
                        context: { requestId: "mistral-live-image-analysis" }
                    },
                    new MultiModalExecutionContext()
                )
            );

            expect(response.output.length).toBeGreaterThan(0);
            expect(response.output[0]?.sourceImageId).toBe("cybercat");
            expect(
                Boolean(response.output[0]?.description) ||
                    (response.output[0]?.tags?.length ?? 0) > 0 ||
                    (response.output[0]?.objects?.length ?? 0) > 0 ||
                    (response.output[0]?.text?.length ?? 0) > 0
            ).toBe(true);
        },
        150000
    );

    it("extracts OCR from a local PNG image end to end", async () => {
        const provider = createMistralProvider();
        const response = await provider.ocr(
            {
                input: {
                    file: new URL("../../../../test_data/test_cybercat.png", import.meta.url).pathname,
                    filename: "test_cybercat.png",
                    mimeType: "image/png",
                    language: "en"
                },
                context: { requestId: "mistral-live-ocr" }
            },
            new MultiModalExecutionContext()
        );

        expect(response.output).toHaveLength(1);
        expect(response.output[0]?.pageCount).toBeGreaterThan(0);
        expect(response.output[0]?.metadata?.provider).toBe(AIProvider.Mistral);
        expect(response.metadata?.provider).toBe(AIProvider.Mistral);
        expect(response.output[0]?.pages?.length).toBeGreaterThan(0);
    }, 150000);

    it("extracts OCR from a local PDF document end to end", async () => {
        const provider = createMistralProvider();
        const response = await provider.ocr(
            {
                input: {
                    file: new URL("../../../../test_data/cl.pdf", import.meta.url).pathname,
                    filename: "cl.pdf",
                    mimeType: "application/pdf",
                    language: "en"
                },
                context: { requestId: "mistral-live-ocr-pdf" }
            },
            new MultiModalExecutionContext()
        );

        expect(response.output).toHaveLength(1);
        expect(response.output[0]?.fileName).toBe("cl.pdf");
        expect(response.output[0]?.pageCount).toBeGreaterThan(0);
        expect((response.output[0]?.fullText ?? "").trim().length).toBeGreaterThan(0);
        expect(response.output[0]?.metadata?.provider).toBe(AIProvider.Mistral);
    }, 150000);

    it("extracts OCR from a local XLSX document end to end", async () => {
        const provider = createMistralProvider();
        const response = await provider.ocr(
            {
                input: {
                    file: new URL("../../../../test_data/Free_Test_Data_100KB_XLSX.xlsx", import.meta.url).pathname,
                    filename: "Free_Test_Data_100KB_XLSX.xlsx",
                    mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                    language: "en"
                },
                context: { requestId: "mistral-live-ocr-xlsx" }
            },
            new MultiModalExecutionContext()
        );

        expect(response.output).toHaveLength(1);
        expect(response.output[0]?.fileName).toBe("Free_Test_Data_100KB_XLSX.xlsx");
        expect(response.output[0]?.pageCount).toBeGreaterThan(0);
        expect((response.output[0]?.fullText ?? "").trim().length).toBeGreaterThan(0);
        expect(response.output[0]?.metadata?.provider).toBe(AIProvider.Mistral);
    }, 150000);

    it("transcribes a local MP3 audio file end to end", async () => {
        const provider = createMistralProvider();
        const response = await provider.transcribeAudio(
            {
                input: {
                    file: new URL("../../../../test_data/test.mp3", import.meta.url).pathname,
                    filename: "test.mp3",
                    mimeType: "audio/mpeg",
                    language: "en",
                    responseFormat: "json",
                    prompt: "Return a clean, punctuation-correct transcript."
                },
                context: { requestId: "mistral-live-audio-transcription" }
            },
            new MultiModalExecutionContext()
        );

        expect(response.output).toHaveLength(1);
        expect(response.output[0]?.role).toBe("assistant");
        const transcriptText =
            response.output[0]?.content
                ?.filter((part) => part.type === "text")
                .map((part) => part.text)
                .join("") ?? "";
        expect(transcriptText.trim().length).toBeGreaterThan(0);
        expect(response.output[0]?.metadata?.provider).toBe(AIProvider.Mistral);
        expect(response.metadata?.provider).toBe(AIProvider.Mistral);
    }, 150000);

    it("synthesizes TTS audio end to end", async () => {
        const provider = createMistralProvider();
        const response = await provider.textToSpeech(
            {
                input: {
                    text: "ProviderPlaneAI Mistral TTS smoke test.",
                    voice: MISTRAL_TEST_VOICE_ID,
                    format: "mp3"
                },
                options: { model: "voxtral-mini-tts-2603" },
                context: { requestId: "mistral-live-tts" }
            },
            new MultiModalExecutionContext()
        );

        expect(response.output).toHaveLength(1);
        expect(response.output[0]?.mimeType).toBe("audio/mpeg");
        expect((response.output[0]?.base64 ?? "").length).toBeGreaterThan(0);
        expect(response.metadata?.provider).toBe(AIProvider.Mistral);
    }, 150000);
});
