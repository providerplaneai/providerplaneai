/**
 * @module client/types/audio/ClientAudioTTSRequest.ts
 * @description Client-facing request and helper types.
 */
import { ClientRequestBase } from "#root/index.js";

/**
 * Output formats commonly supported by text-to-speech providers.
 *
 * @public
 */
export type ClientTextToSpeechFormat = "mp3" | "opus" | "aac" | "flac" | "wav" | "pcm";

/**
 * Streaming transport formats used by providers that can emit TTS output incrementally.
 *
 * @public
 */
export type ClientTextToSpeechStreamFormat = "sse" | "audio";

/**
 * Request payload for text-to-speech synthesis.
 *
 * @public
 */
export interface ClientTextToSpeechRequest extends ClientRequestBase {
    /**
     * Text content to synthesize into speech.
     */
    text: string;
    /**
     * Optional voice name (provider-specific, e.g. alloy/nova/verse).
     */
    voice?: string;
    /**
     * Optional output audio format.
     */
    format?: ClientTextToSpeechFormat;
    /**
     * Optional speaking speed multiplier.
     */
    speed?: number;
    /**
     * Optional style/instruction text for compatible models.
     */
    instructions?: string;
    /**
     * Optional stream format for providers that support streamed TTS output.
     */
    streamFormat?: ClientTextToSpeechStreamFormat;
}
