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
 *
 * @public
 */
export interface AudioTranscriptionCapability<TInput = unknown, TOutput = NormalizedChatMessage[]> extends ProviderCapability {
    /**
     * Transcribe input audio into text.
     *
     * @param {AIRequest<TInput>} request - Unified AI request containing transcription input.
     * @param {MultiModalExecutionContext} ctx - Execution context.
     * @param {AbortSignal | undefined} signal - Optional abort signal.
     * @returns {Promise<AIResponse<TOutput>>} AIResponse containing normalized transcript artifacts.
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
 *
 * @public
 */
export interface AudioTranscriptionStreamCapability<
    TInput = unknown,
    TOutput = NormalizedChatMessage[]
> extends ProviderCapability {
    /**
     * Stream transcription deltas for input audio.
     *
     * @param {AIRequest<TInput>} request - Unified AI request containing transcription input.
     * @param {MultiModalExecutionContext} ctx - Execution context.
     * @param {AbortSignal | undefined} signal - Optional abort signal.
     * @returns {AsyncGenerator<AIResponseChunk<TOutput>>} Async generator yielding transcript deltas and final output.
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
 * Translates spoken audio to a target language when supported by the provider.
 *
 * @public
 */
export interface AudioTranslationCapability<TInput = unknown, TOutput = NormalizedChatMessage[]> extends ProviderCapability {
    /**
     * Translate input audio and return transcript artifacts.
     *
     * @param {AIRequest<TInput>} request - Unified AI request containing translation input.
     * @param {MultiModalExecutionContext} ctx - Execution context.
     * @param {AbortSignal | undefined} signal - Optional abort signal.
     * @returns {Promise<AIResponse<TOutput>>} AIResponse containing normalized translated transcript artifacts.
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
 *
 * @public
 */
export interface TextToSpeechCapability<TInput = unknown, TOutput = NormalizedAudio[]> extends ProviderCapability {
    /**
     * Synthesize speech from text.
     *
     * @param {AIRequest<TInput>} request - Unified AI request containing TTS input.
     * @param {MultiModalExecutionContext} ctx - Execution context.
     * @param {AbortSignal | undefined} signal - Optional abort signal.
     * @returns {Promise<AIResponse<TOutput>>} AIResponse containing normalized generated audio artifacts.
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
 *
 * @public
 */
export interface TextToSpeechStreamCapability<TInput = unknown, TOutput = NormalizedAudio[]> extends ProviderCapability {
    /**
     * Stream speech synthesis output from text.
     *
     * @param {AIRequest<TInput>} request - Unified AI request containing TTS input.
     * @param {MultiModalExecutionContext} ctx - Execution context.
     * @param {AbortSignal | undefined} signal - Optional abort signal.
     * @returns {AsyncGenerator<AIResponseChunk<TOutput>>} Async generator yielding partial and final audio output.
     */
    textToSpeechStream(
        request: AIRequest<TInput>,
        ctx: MultiModalExecutionContext,
        signal?: AbortSignal
    ): AsyncGenerator<AIResponseChunk<TOutput>>;
}
