/**
 * @module core/utils/AudioUtils.ts
 * @description Shared helpers for constructing normalized audio artifacts.
 */
import { NormalizedAudio } from "#root/index.js";

/**
 * Parameters used to build a normalized audio artifact.
 */
export type AudioArtifactParams = {
    /** Stable identifier to preserve when rehydrating an existing artifact. */
    id?: string;
    /** Provider-specific audio kind, such as speech or music, when known. */
    kind?: NormalizedAudio["kind"];
    /** MIME type for the audio payload. */
    mimeType: string;
    /** Remote URL for the audio payload when hosted externally. */
    url?: string;
    /** Inline base64 payload when the audio is carried directly in the response. */
    base64?: string;
    /** Transcript text associated with the audio payload. */
    transcript?: string;
    /** Total audio duration in seconds when provided by the provider. */
    durationSeconds?: number;
    /** Audio sample rate in Hertz when known. */
    sampleRateHz?: number;
    /** Number of audio channels when known. */
    channels?: number;
    /** Average audio bitrate in bits per second when known. */
    bitrate?: number;
    /** Provider-native response payload retained for debugging or inspection. */
    raw?: unknown;
};

/**
 * Builds a normalized audio artifact from the subset of fields a capability produced.
 *
 * Undefined optional fields are omitted so providers only expose metadata they actually know.
 *
 * @param {AudioArtifactParams} params - Normalized audio fields to include in the artifact.
 * @returns {NormalizedAudio} A normalized audio artifact with a generated identifier when one is not supplied.
 */
export function createAudioArtifact(params: AudioArtifactParams): NormalizedAudio {
    return {
        id: params.id ?? crypto.randomUUID(),
        ...(params.kind ? { kind: params.kind } : {}),
        mimeType: params.mimeType,
        ...(params.url ? { url: params.url } : {}),
        ...(params.base64 ? { base64: params.base64 } : {}),
        ...(params.transcript ? { transcript: params.transcript } : {}),
        ...(params.durationSeconds !== undefined ? { durationSeconds: params.durationSeconds } : {}),
        ...(params.sampleRateHz !== undefined ? { sampleRateHz: params.sampleRateHz } : {}),
        ...(params.channels !== undefined ? { channels: params.channels } : {}),
        ...(params.bitrate !== undefined ? { bitrate: params.bitrate } : {}),
        ...(params.raw !== undefined ? { raw: params.raw } : {})
    };
}
