export type AudioErrorCode =
    | "AUDIO_EMPTY_RESPONSE"
    | "AUDIO_OUTPUT_TOO_LARGE"
    | "AUDIO_INVALID_PAYLOAD"
    | "AUDIO_UNSUPPORTED_INPUT"
    | "AUDIO_REQUEST_ABORTED";

/**
 * Structured error for audio capability failures.
 *
 * Message is prefixed with code so existing error-string telemetry still carries
 * a machine-readable token even when only `error.message` is persisted.
 */
export class AudioCapabilityError extends Error {
    constructor(
        public readonly code: AudioErrorCode,
        message: string,
        public readonly details?: Record<string, unknown>
    ) {
        super(`[${code}] ${message}`);
        this.name = "AudioCapabilityError";
    }
}
