/**
 * @module core/types/artifacts/NormalizedAudio.ts
 * @description Normalized audio artifact contract shared by TTS and audio-processing capabilities.
 */
import { NormalizedArtifactBase } from "#root/index.js";

/**
 * Provider-agnostic audio artifact.
 * This is the canonical output type for TTS capabilities.
 */
/**
 * @public
 * Provider-agnostic audio artifact.
 */
export interface NormalizedAudio extends NormalizedArtifactBase {
    kind?: "tts" | "audio";
    mimeType: string;
    url?: string;
    base64?: string;
    transcript?: string;
    durationSeconds?: number;
    sampleRateHz?: number;
    channels?: number;
    bitrate?: number;
}
