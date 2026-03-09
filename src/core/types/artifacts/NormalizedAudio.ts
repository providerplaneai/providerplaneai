/**
 * @module core/types/artifacts/NormalizedAudio.ts
 * @description Core shared type definitions used by runtime, providers, and workflows.
 */
import { NormalizedArtifactBase } from "#root/index.js";

/**
 * Provider-agnostic audio artifact.
 * This is the canonical output type for TTS capabilities.
 */
/**
 * @public
 * @description Data contract for NormalizedAudio.
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
