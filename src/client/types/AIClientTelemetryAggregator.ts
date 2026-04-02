/**
 * @module client/types/AIClientTelemetryAggregator.ts
 * @description Telemetry aggregation helpers for AI client lifecycle hooks.
 */
import { AIClientLifecycleHooks, CapabilityKeyType, ProviderAttemptResult } from "#root/index.js";

/**
 * Accumulates attempt counts, duration, and token/cost totals for a telemetry slice.
 *
 * @public
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
 * Telemetry totals grouped overall, by provider, and by capability.
 *
 * @public
 */
export interface TelemetrySummary {
    overall: TelemetryTotals;
    byProvider: Record<string, TelemetryTotals>;
    byCapability: Record<string, TelemetryTotals>;
}

/**
 * Creates a zeroed telemetry accumulator.
 *
 * @returns {TelemetryTotals} A totals object with all counters initialized to zero.
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
 * Collects and summarizes AI client telemetry from lifecycle hook callbacks.
 *
 * @public
 */
export class AIClientTelemetryAggregator {
    private overall: TelemetryTotals = emptyTotals();
    private byProvider = new Map<string, TelemetryTotals>();
    private byCapability = new Map<string, TelemetryTotals>();
    /**
     * Lifecycle hooks that can be passed directly into AIClient config.
     *
     * @returns {AIClientLifecycleHooks} Hook implementations that record provider attempt outcomes.
     */
    createHooks(): AIClientLifecycleHooks {
        return {
            onAttemptSuccess: (result) => this.recordAttempt(result),
            onAttemptFailure: (result) => this.recordAttempt(result)
        };
    }

    /**
     * Clears all accumulated telemetry state.
     *
     * @returns {void} Nothing.
     */
    reset() {
        this.overall = emptyTotals();
        this.byProvider.clear();
        this.byCapability.clear();
    }

    /**
     * Returns the current aggregated telemetry summary.
     *
     * @returns {TelemetrySummary} A snapshot of overall, provider-level, and capability-level totals.
     */
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
