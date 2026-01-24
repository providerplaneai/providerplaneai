import { ClientRequestBase } from "../shared/index.js";

/**
 * Request payload for audio translation.
 *
 * - `file`: Audio file or blob to translate.
 * - `targetLanguage`: Optional target language for translation.
 */
export interface ClientAudioTranslationRequest extends ClientRequestBase {
    file: File | Blob;
    targetLanguage?: string;
}
