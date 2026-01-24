import { ClientRequestBase } from "../shared/index.js";

/**
 * Request payload for text-to-speech (TTS) synthesis.
 *
 * - `text`: The text to synthesize.
 * - `voice`: Optional voice selection.
 * - `format`: Optional output format (e.g., mp3, wav).
 */
export interface ClientTextToSpeechRequest extends ClientRequestBase {
    text: string;
    voice?: string;
    format?: string;
}
