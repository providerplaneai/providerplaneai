/**
 * @module core/utils/PollingUtils.ts
 * @description Shared polling helpers for long-running provider operations.
 */

/**
 * @public
 * @description Helper type for PollingWindowOptions.
 */
export type PollingWindowOptions = {
    pollIntervalMs?: number;
    maxPollMs?: number;
    defaultPollIntervalMs: number;
    defaultMaxPollMs: number;
    minPollIntervalMs?: number;
};

/**
 * Resolves poll interval and timeout bounds into a predictable polling window.
 *
 * @public
 * @description Helper utility for resolvePollingWindow.
 * @param options Polling configuration input.
 * @returns Normalized helper result.
 */
export function resolvePollingWindow(options: PollingWindowOptions): {
    pollIntervalMs: number;
    maxPollMs: number;
} {
    const minPollIntervalMs = Math.max(0, Number(options.minPollIntervalMs ?? 0));
    const pollIntervalMs = Math.max(minPollIntervalMs, Number(options.pollIntervalMs ?? options.defaultPollIntervalMs));
    const maxPollMs = Math.max(pollIntervalMs, Number(options.maxPollMs ?? options.defaultMaxPollMs));
    return { pollIntervalMs, maxPollMs };
}

/**
 * Sleeps for the requested delay and rejects early if the request is aborted.
 *
 * @public
 * @description Helper utility for delayWithAbort.
 * @param ms Delay duration in milliseconds.
 * @param signal Optional abort signal.
 * @param abortMessage Error message used when aborted.
 * @returns Normalized helper result.
 */
export function delayWithAbort(ms: number, signal: AbortSignal | undefined, abortMessage: string): Promise<void> {
    if (ms <= 0) {
        return Promise.resolve();
    }

    return new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
            signal?.removeEventListener("abort", onAbort);
            resolve();
        }, ms);

        const onAbort = () => {
            clearTimeout(timer);
            reject(new Error(abortMessage));
        };

        if (signal) {
            if (signal.aborted) {
                onAbort();
                return;
            }
            signal.addEventListener("abort", onAbort, { once: true });
        }
    });
}
