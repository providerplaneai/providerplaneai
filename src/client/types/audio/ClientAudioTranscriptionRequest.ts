/**
 * @module client/types/audio/ClientAudioTranscriptionRequest.ts
 * @description ProviderPlaneAI source module.
 */
import { ClientRequestBase } from "../shared/index.js";

/**
 * Supported audio input source types across browser and Node runtimes.
 *
 * Notes:
 * - Browser: File/Blob
 * - Node: Buffer/Uint8Array/ArrayBuffer/Readable stream
 * - Some providers may also accept a local path string or data URL string
 */
/**
 * @public
 * @description Type alias for ClientAudioInputSource.
 */
export type ClientAudioInputSource = File | Blob | Buffer | Uint8Array | ArrayBuffer | NodeJS.ReadableStream | string;

/**
 * Common response formats used by transcription-capable providers.
 */
/**
 * @public
 * @description Type alias for ClientAudioTranscriptionResponseFormat.
 */
export type ClientAudioTranscriptionResponseFormat = "json" | "text" | "srt" | "verbose_json" | "vtt" | "diarized_json";

/**
 * Request payload for audio transcription.
 *
 * - `file`: Audio content to transcribe.
 * - `language`: Optional language hint for transcription.
 */
/**
 * @public
 * @description Interface contract for ClientAudioTranscriptionRequest.
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
