import { AIClientLifecycleHooks, CapabilityKeyType, ProviderAttemptResult } from "#root/index.js";

export interface TelemetryTotals {
    attempts: number;
    successes: number;
    failures: number;
    durationMs: number;
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    estimatedCostUsd: number;
}

export interface TelemetrySummary {
    overall: TelemetryTotals;
    byProvider: Record<string, TelemetryTotals>;
    byCapability: Record<string, TelemetryTotals>;
}

function emptyTotals(): TelemetryTotals {
    return {
        attempts: 0,
        successes: 0,
        failures: 0,
        durationMs: 0,
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        estimatedCostUsd: 0
    };
}

export class AIClientTelemetryAggregator {
    private overall: TelemetryTotals = emptyTotals();
    private byProvider = new Map<string, TelemetryTotals>();
    private byCapability = new Map<string, TelemetryTotals>();

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
        target.estimatedCostUsd += result.estimatedCostUsd ?? 0;
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
