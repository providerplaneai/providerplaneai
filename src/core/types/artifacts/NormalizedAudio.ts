import { NormalizedArtifactBase } from "#root/index.js";

/**
 * Provider-agnostic audio artifact.
 * This is the canonical output type for TTS capabilities.
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
