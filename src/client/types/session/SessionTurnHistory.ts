/**
 * Represents a single turn in a capability execution.
 *
 * Captures the input, provider output, and optional multimodal artifacts for each turn.
 *
 * @template TInput - Input type for the turn
 * @template TProviderOutput - Output type from the provider
 */
export interface SessionTurnHistoryEntry<TInput = unknown, TProviderOutput = unknown> {
    /** Turn index */
    turn: number;

    /** Input provided for this turn */
    input: TInput;

    /** Completed provider output (non-streaming) */
    providerOutput?: TProviderOutput;

    /** Optional multimodal artifacts produced in this turn */
    multimodalArtifacts?: Record<string, unknown>;
}
