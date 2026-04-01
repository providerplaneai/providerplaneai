/**
 * @module client/types/audio/ClientAudioTranscriptionRequest.ts
 * @description Client-facing request and helper types.
 */
import { ClientFileInputSource, ClientRequestBase } from "#root/index.js";

/**
 * Alias for the file input types accepted by transcription and translation requests.
 *
 * @public
 */
export type ClientAudioInputSource = ClientFileInputSource;

/**
 * Output formats commonly supported by transcription providers.
 *
 * @public
 */
export type ClientAudioTranscriptionResponseFormat = "json" | "text" | "srt" | "verbose_json" | "vtt" | "diarized_json";

/**
 * Request payload for speech transcription.
 *
 * @public
 */
export interface ClientAudioTranscriptionRequest extends ClientRequestBase {
    /**
     * Audio source to transcribe.
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
     * Optional input language hint (e.g. "en").
     */
    language?: string;
    /**
     * Optional prompt to guide transcription style/terms.
     */
    prompt?: string;
    /**
     * Optional sampling temperature.
     */
    temperature?: number;
    /**
     * Requested transcript output format.
     */
    responseFormat?: ClientAudioTranscriptionResponseFormat;
    /**
     * Optional include flags such as token logprobs for supported providers.
     */
    include?: Array<"logprobs">;
    /**
     * Whether to request a streaming transcription response when supported.
     */
    stream?: boolean;
    /**
     * Optional known speaker labels for diarization-capable providers.
     */
    knownSpeakerNames?: string[];
}
