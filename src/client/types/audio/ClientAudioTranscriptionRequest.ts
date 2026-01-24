import { ClientRequestBase } from "../shared/index.js";

/**
 * Request payload for audio transcription.
 *
 * - `file`: Audio file or blob to transcribe.
 * - `language`: Optional language hint for transcription.
 */
export interface ClientAudioTranscriptionRequest extends ClientRequestBase {
    file: File | Blob;
    language?: string;
}
