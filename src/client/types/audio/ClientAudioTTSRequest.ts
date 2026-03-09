/**
 * @module client/types/audio/ClientAudioTTSRequest.ts
 * @description ProviderPlaneAI source module.
 */
import { ClientRequestBase } from "../shared/index.js";

/**
 * Common output formats used by text-to-speech providers.
 */
/**
 * @public
 * @description Type alias for ClientTextToSpeechFormat.
 */
export type ClientTextToSpeechFormat = "mp3" | "opus" | "aac" | "flac" | "wav" | "pcm";

/**
 * Stream transport format for providers that support streamed TTS.
 */
/**
 * @public
 * @description Type alias for ClientTextToSpeechStreamFormat.
 */
export type ClientTextToSpeechStreamFormat = "sse" | "audio";

/**
 * Request payload for text-to-speech (TTS) synthesis.
 *
 * - `text`: The text to synthesize.
 * - `voice`: Optional voice selection.
 * - `format`: Optional output format (e.g., mp3, wav).
 */
/**
 * @public
 * @description Interface contract for ClientTextToSpeechRequest.
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
