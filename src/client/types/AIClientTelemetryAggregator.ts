import { AIClientLifecycleHooks, CapabilityKeyType, ProviderAttemptResult } from "#root/index.js";

/**
 * Aggregates telemetry statistics for AIClient attempts.
 * Includes counts, token usage, duration, and estimated cost.
 */
export interface TelemetryTotals {
    attempts: number;
    successes: number;
    failures: number;
    durationMs: number;
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    estimatedCost: number;
}

/**
 * Summary of telemetry statistics, grouped overall, by provider, and by capability.
 */
export interface TelemetrySummary {
    overall: TelemetryTotals;
    byProvider: Record<string, TelemetryTotals>;
    byCapability: Record<string, TelemetryTotals>;
}

/**
 * Returns a new TelemetryTotals object with all fields zeroed.
 */
function emptyTotals(): TelemetryTotals {
    return {
        attempts: 0,
        successes: 0,
        failures: 0,
        durationMs: 0,
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        estimatedCost: 0
    };
}

/**
 * Aggregates and summarizes telemetry data for AIClient executions.
 * Provides hooks for recording attempt results and methods for resetting and summarizing data.
 */
export class AIClientTelemetryAggregator {
    private overall: TelemetryTotals = emptyTotals();
    private byProvider = new Map<string, TelemetryTotals>();
    private byCapability = new Map<string, TelemetryTotals>();

    /** Lifecycle hooks that can be passed directly into AIClient config. */
    createHooks(): AIClientLifecycleHooks {
        return {
            onAttemptSuccess: (result) => this.recordAttempt(result),
            onAttemptFailure: (result) => this.recordAttempt(result)
        };
    }

    reset() {
        this.overall = emptyTotals();
        this.byProvider.clear();
        this.byCapability.clear();
    }

    getSummary(): TelemetrySummary {
        return {
            overall: { ...this.overall },
            byProvider: this.mapToObject(this.byProvider),
            byCapability: this.mapToObject(this.byCapability)
        };
    }

    private recordAttempt(result: ProviderAttemptResult) {
        // Connection name is part of the provider key so "openai:prod" and
        // "openai:staging" are tracked independently.
        const providerKey = `${result.providerType}:${result.connectionName ?? "default"}`;
        const capabilityKey = result.capability as CapabilityKeyType;

        this.apply(this.overall, result);
        this.apply(this.getOrInit(this.byProvider, providerKey), result);
        this.apply(this.getOrInit(this.byCapability, capabilityKey), result);
    }

    private apply(target: TelemetryTotals, result: ProviderAttemptResult) {
        target.attempts++;
        if (result.error) {
            target.failures++;
        } else {
            target.successes++;
        }

        target.durationMs += result.durationMs ?? 0;
        target.inputTokens += result.inputTokens ?? 0;
        target.outputTokens += result.outputTokens ?? 0;
        target.totalTokens += result.totalTokens ?? 0;
        target.estimatedCost += result.estimatedCost ?? 0;
    }

    private getOrInit(map: Map<string, TelemetryTotals>, key: string): TelemetryTotals {
        const existing = map.get(key);
        if (existing) {
            return existing;
        }

        const created = emptyTotals();
        map.set(key, created);
        return created;
    }

    private mapToObject(map: Map<string, TelemetryTotals>): Record<string, TelemetryTotals> {
        const out: Record<string, TelemetryTotals> = {};
        for (const [key, value] of map.entries()) {
            out[key] = { ...value };
        }
        return out;
    }
}
