import { describe, expect, it } from "vitest";
import dotenv from "dotenv";
import {
    AIProvider,
    OpenAIProvider,
    MultiModalExecutionContext,
    type ProviderConnectionConfig
} from "#root/index.js";

dotenv.config({ quiet: true });

const RUN_LIVE_INTEGRATION = process.env.RUN_LIVE_INTEGRATION === "1";
const REQUIRED_ENV_VARS = ["OPENAI_API_KEY_1"] as const;
const OPENAI_RATE_LIMIT_RETRY_DELAYS_MS = [30000] as const;

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
const describeOpenAILive = RUN_LIVE_INTEGRATION && hasProviderKeys ? describe : describe.skip;

function isOpenAIRateLimitError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error ?? "");
    return message.includes("429") || message.toLowerCase().includes("rate limit");
}

async function retryOnOpenAIRateLimit<T>(operation: () => Promise<T>): Promise<T> {
    let lastError: unknown;

    for (let attempt = 0; attempt <= OPENAI_RATE_LIMIT_RETRY_DELAYS_MS.length; attempt += 1) {
        try {
            return await operation();
        } catch (error) {
            lastError = error;
            if (!isOpenAIRateLimitError(error) || attempt === OPENAI_RATE_LIMIT_RETRY_DELAYS_MS.length) {
                throw error;
            }

            await new Promise((resolve) => setTimeout(resolve, OPENAI_RATE_LIMIT_RETRY_DELAYS_MS[attempt]));
        }
    }

    throw lastError;
}

function createOpenAIProvider(): OpenAIProvider {
    const provider = new OpenAIProvider();
    const config: ProviderConnectionConfig = {
        type: AIProvider.OpenAI,
        apiKeyEnvVar: "OPENAI_API_KEY_1",
        apiKey: process.env.OPENAI_API_KEY_1,
        defaultModel: "gpt-4.1",
        defaultModels: {
            ocr: "gpt-4.1"
        },
        models: {
            "gpt-4.1": {
                ocr: {}
            }
        }
    };

    provider.init(config);
    return provider;
}

describeOpenAILive("OpenAI live integration", () => {
    it("extracts OCR from a local PNG image end to end", async () => {
        const provider = createOpenAIProvider();
        const response = await retryOnOpenAIRateLimit(() =>
            provider.ocr(
                {
                    input: {
                        file: new URL("../../../../test_data/screenshot_20250815162207.png", import.meta.url).pathname,
                        filename: "screenshot_20250815162207.png",
                        mimeType: "image/png",
                        language: "en"
                    },
                    context: { requestId: "openai-live-ocr-png" }
                },
                new MultiModalExecutionContext()
            )
        );

        expect(response.output).toHaveLength(1);
        expect(response.output[0]?.metadata?.provider).toBe(AIProvider.OpenAI);
        expect(response.metadata?.provider).toBe(AIProvider.OpenAI);
        expect((response.output[0]?.fullText ?? "").trim().length).toBeGreaterThan(0);
    }, 150000);

    it("extracts OCR from a local PDF document end to end", async () => {
        const provider = createOpenAIProvider();
        const response = await retryOnOpenAIRateLimit(() =>
            provider.ocr(
                {
                    input: {
                        file: new URL("../../../../test_data/cl.pdf", import.meta.url).pathname,
                        filename: "cl.pdf",
                        mimeType: "application/pdf",
                        language: "en"
                    },
                    context: { requestId: "openai-live-ocr-pdf" }
                },
                new MultiModalExecutionContext()
            )
        );

        expect(response.output).toHaveLength(1);
        expect(response.output[0]?.fileName).toBe("cl.pdf");
        expect(response.output[0]?.metadata?.provider).toBe(AIProvider.OpenAI);
        expect((response.output[0]?.fullText ?? "").trim().length).toBeGreaterThan(0);
    }, 150000);
});
