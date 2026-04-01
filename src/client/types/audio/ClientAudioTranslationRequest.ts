/**
 * @module client/types/audio/ClientAudioTranslationRequest.ts
 * @description Client-facing request and helper types.
 */
import { ClientAudioInputSource, ClientRequestBase } from "#root/index.js";

/**
 * Output formats commonly supported by audio translation providers.
 *
 * @public
 */
export type ClientAudioTranslationResponseFormat = "json" | "text" | "srt" | "verbose_json" | "vtt";

/**
 * Request payload for speech-to-text translation.
 *
 * @public
 */
export interface ClientAudioTranslationRequest extends ClientRequestBase {
    /**
     * Audio source to translate.
     */
    file: ClientAudioInputSource;
    /**
     * Optional filename hint (useful when input is bytes/stream).
     */
    filename?: string;
    /**
     * Optional MIME type hint (e.g. audio/mpeg, audio/wav).
     */
    mimeType?: string;
    /**
     * Optional prompt to guide translation style/terms.
     */
    prompt?: string;
    /**
     * Optional sampling temperature.
     */
    temperature?: number;
    /**
     * Requested translation output format.
     */
    responseFormat?: ClientAudioTranslationResponseFormat;

    /**
     * Optional target language hint.
     * Some providers constrain supported targets (e.g. English-only translation).
     */
    targetLanguage?: string;
}
