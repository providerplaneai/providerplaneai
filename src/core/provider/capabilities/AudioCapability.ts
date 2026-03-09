/**
 * @module core/provider/capabilities/AudioCapability.ts
 * @description Provider-agnostic audio capability interface contracts.
 */
import {
    AIRequest,
    AIResponse,
    AIResponseChunk,
    MultiModalExecutionContext,
    NormalizedAudio,
    NormalizedChatMessage,
    ProviderCapability
} from "#root/index.js";

/**
 * Provider-agnostic audio transcription capability.
 *
 * Converts speech audio to text/transcript artifacts.
 */
/**
 * @public
 * @description Capability contract for AudioTranscriptionCapability.
 */
export interface AudioTranscriptionCapability<TInput = unknown, TOutput = NormalizedChatMessage[]> extends ProviderCapability {
    /**
     * Transcribe input audio into text.
     *
     * @param request Unified AI request containing transcription input
     * @param ctx Execution context
     * @param signal Optional abort signal
     * @returns AIResponse containing normalized chat message artifacts with transcript data
     */
    transcribeAudio(
        request: AIRequest<TInput>,
        ctx: MultiModalExecutionContext,
        signal?: AbortSignal
    ): Promise<AIResponse<TOutput>>;
}

/**
 * Provider-agnostic streaming audio transcription capability.
 *
 * Streams incremental transcription deltas and emits a final transcript output.
 */
/**
 * @public
 * @description Capability contract for AudioTranscriptionStreamCapability.
 */
export interface AudioTranscriptionStreamCapability<
    TInput = unknown,
    TOutput = NormalizedChatMessage[]
> extends ProviderCapability {
    /**
     * Stream transcription deltas for input audio.
     *
     * @param request Unified AI request containing transcription input
     * @param ctx Execution context
     * @param signal Optional abort signal
     * @returns AsyncGenerator yielding transcript deltas and final output
     */
    transcribeAudioStream(
        request: AIRequest<TInput>,
        ctx: MultiModalExecutionContext,
        signal?: AbortSignal
    ): AsyncGenerator<AIResponseChunk<TOutput>>;
}

/**
 * Provider-agnostic audio translation capability.
 *
 * Translates spoken audio to a target language (provider-dependent support).
 */
/**
 * @public
 * @description Capability contract for AudioTranslationCapability.
 */
export interface AudioTranslationCapability<TInput = unknown, TOutput = NormalizedChatMessage[]> extends ProviderCapability {
    /**
     * Translate input audio and return transcript artifacts.
     *
     * @param request Unified AI request containing translation input
     * @param ctx Execution context
     * @param signal Optional abort signal
     * @returns AIResponse containing normalized chat message artifacts with translated transcript data
     */
    translateAudio(
        request: AIRequest<TInput>,
        ctx: MultiModalExecutionContext,
        signal?: AbortSignal
    ): Promise<AIResponse<TOutput>>;
}

/**
 * Provider-agnostic text-to-speech capability.
 *
 * Converts text into synthesized audio artifacts.
 */
/**
 * @public
 * @description Capability contract for TextToSpeechCapability.
 */
export interface TextToSpeechCapability<TInput = unknown, TOutput = NormalizedAudio[]> extends ProviderCapability {
    /**
     * Synthesize speech from text.
     *
     * @param request Unified AI request containing TTS input
     * @param ctx Execution context
     * @param signal Optional abort signal
     * @returns AIResponse containing normalized generated audio artifacts
     */
    textToSpeech(
        request: AIRequest<TInput>,
        ctx: MultiModalExecutionContext,
        signal?: AbortSignal
    ): Promise<AIResponse<TOutput>>;
}

/**
 * Provider-agnostic streaming text-to-speech capability.
 *
 * Streams generated audio chunks and emits the final synthesized artifact.
 */
/**
 * @public
 * @description Capability contract for TextToSpeechStreamCapability.
 */
export interface TextToSpeechStreamCapability<TInput = unknown, TOutput = NormalizedAudio[]> extends ProviderCapability {
    /**
     * Stream speech synthesis output from text.
     *
     * @param request Unified AI request containing TTS input
     * @param ctx Execution context
     * @param signal Optional abort signal
     * @returns AsyncGenerator yielding partial and final audio output
     */
    textToSpeechStream(
        request: AIRequest<TInput>,
        ctx: MultiModalExecutionContext,
        signal?: AbortSignal
    ): AsyncGenerator<AIResponseChunk<TOutput>>;
}
