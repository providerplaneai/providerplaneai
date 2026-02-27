import { describe, expect, it } from "vitest";
import { AIProvider, type ProviderAttemptResult } from "#root/index.js";
import { AIClientTelemetryAggregator } from "#root/client/types/AIClientTelemetryAggregator.js";

function makeAttempt(overrides?: Partial<ProviderAttemptResult>): ProviderAttemptResult {
    return {
        capability: "chat",
        providerType: AIProvider.OpenAI,
        connectionName: "default",
        attemptIndex: 0,
        startTime: 1,
        durationMs: 10,
        ...overrides
    };
}

describe("AIClientTelemetryAggregator", () => {
    it("starts with empty telemetry summary", () => {
        const aggregator = new AIClientTelemetryAggregator();
        const summary = aggregator.getSummary();

        expect(summary.overall).toEqual({
            attempts: 0,
            successes: 0,
            failures: 0,
            durationMs: 0,
            inputTokens: 0,
            outputTokens: 0,
            totalTokens: 0,
            estimatedCost: 0
        });
        expect(summary.byProvider).toEqual({});
        expect(summary.byCapability).toEqual({});
    });

    it("records success and failure attempts via lifecycle hooks", () => {
        const aggregator = new AIClientTelemetryAggregator();
        const hooks = aggregator.createHooks();

        hooks.onAttemptSuccess?.(makeAttempt({ durationMs: 12, inputTokens: 5, outputTokens: 7, totalTokens: 12, estimatedCost: 0.2 }));
        hooks.onAttemptFailure?.(makeAttempt({ error: "boom", durationMs: 8, inputTokens: 1, outputTokens: 0, totalTokens: 1 }));

        const summary = aggregator.getSummary();
        expect(summary.overall).toEqual({
            attempts: 2,
            successes: 1,
            failures: 1,
            durationMs: 20,
            inputTokens: 6,
            outputTokens: 7,
            totalTokens: 13,
            estimatedCost: 0.2
        });
    });

    it("groups totals by provider connection and by capability", () => {
        const aggregator = new AIClientTelemetryAggregator();
        const hooks = aggregator.createHooks();

        hooks.onAttemptSuccess?.(
            makeAttempt({
                providerType: AIProvider.OpenAI,
                connectionName: "default",
                capability: "chat",
                durationMs: 10
            })
        );
        hooks.onAttemptSuccess?.(
            makeAttempt({
                providerType: AIProvider.OpenAI,
                connectionName: "fallback",
                capability: "embed",
                durationMs: 20
            })
        );
        hooks.onAttemptFailure?.(
            makeAttempt({
                providerType: AIProvider.Anthropic,
                connectionName: "default",
                capability: "chat",
                durationMs: 30,
                error: "failed"
            })
        );

        const summary = aggregator.getSummary();
        expect(summary.byProvider["openai:default"].attempts).toBe(1);
        expect(summary.byProvider["openai:fallback"].attempts).toBe(1);
        expect(summary.byProvider["anthropic:default"].failures).toBe(1);

        expect(summary.byCapability["chat"].attempts).toBe(2);
        expect(summary.byCapability["chat"].failures).toBe(1);
        expect(summary.byCapability["embed"].attempts).toBe(1);
    });

    it("uses default connection key when connectionName is not provided", () => {
        const aggregator = new AIClientTelemetryAggregator();
        const hooks = aggregator.createHooks();

        hooks.onAttemptSuccess?.(
            makeAttempt({
                providerType: AIProvider.Gemini,
                connectionName: undefined
            })
        );

        const summary = aggregator.getSummary();
        expect(summary.byProvider["gemini:default"].attempts).toBe(1);
    });

    it("treats undefined numeric metrics as zero", () => {
        const aggregator = new AIClientTelemetryAggregator();
        const hooks = aggregator.createHooks();

        hooks.onAttemptSuccess?.(
            makeAttempt({
                durationMs: 0,
                inputTokens: undefined,
                outputTokens: undefined,
                totalTokens: undefined,
                estimatedCost: undefined
            })
        );

        const summary = aggregator.getSummary();
        expect(summary.overall.inputTokens).toBe(0);
        expect(summary.overall.outputTokens).toBe(0);
        expect(summary.overall.totalTokens).toBe(0);
        expect(summary.overall.estimatedCost).toBe(0);
    });

    it("reset clears all recorded telemetry", () => {
        const aggregator = new AIClientTelemetryAggregator();
        const hooks = aggregator.createHooks();

        hooks.onAttemptSuccess?.(makeAttempt({ durationMs: 10 }));
        hooks.onAttemptFailure?.(makeAttempt({ durationMs: 20, error: "failed" }));
        aggregator.reset();

        const summary = aggregator.getSummary();
        expect(summary.overall.attempts).toBe(0);
        expect(summary.overall.successes).toBe(0);
        expect(summary.overall.failures).toBe(0);
        expect(summary.byProvider).toEqual({});
        expect(summary.byCapability).toEqual({});
    });

    it("returns defensive summary copies", () => {
        const aggregator = new AIClientTelemetryAggregator();
        const hooks = aggregator.createHooks();

        hooks.onAttemptSuccess?.(
            makeAttempt({
                providerType: AIProvider.OpenAI,
                connectionName: "default",
                capability: "chat"
            })
        );

        const first = aggregator.getSummary();
        first.overall.attempts = 999;
        first.byProvider["openai:default"].attempts = 999;
        first.byCapability["chat"].attempts = 999;

        const second = aggregator.getSummary();
        expect(second.overall.attempts).toBe(1);
        expect(second.byProvider["openai:default"].attempts).toBe(1);
        expect(second.byCapability["chat"].attempts).toBe(1);
    });
});

