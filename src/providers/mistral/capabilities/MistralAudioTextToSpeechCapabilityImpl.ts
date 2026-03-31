/**
 * @module providers/mistral/capabilities/MistralAudioTextToSpeechCapabilityImpl.ts
 * @description Mistral text-to-speech capability adapter.
 */
import { Mistral } from "@mistralai/mistralai";
import type { SpeechRequest, UsageInfoDollarDefs } from "@mistralai/mistralai/models/components";
import type { SpeechResponse, SpeechStreamEvents } from "@mistralai/mistralai/models/operations";
import {
    AIProvider,
    AIRequest,
    AIResponse,
    AIResponseChunk,
    BaseProvider,
    CapabilityKeys,
    ClientTextToSpeechRequest,
    createAudioArtifact,
    getMimeTypeForExtensionOrFormat,
    MultiModalExecutionContext,
    NormalizedAudio,
    TextToSpeechCapability,
    TextToSpeechStreamCapability
} from "#root/index.js";

const DEFAULT_MISTRAL_TTS_MODEL = "voxtral-mini-tts-2603";

/**
 * Adapts Mistral text-to-speech output into ProviderPlaneAI's normalized audio artifact surface.
 *
 * Uses Mistral's dedicated speech API for both one-shot synthesis and streaming
 * audio deltas, normalizing each mode to `NormalizedAudio[]`.
 *
 * @public
 * @description Provider capability implementation for MistralAudioTextToSpeechCapabilityImpl.
 */
export class MistralAudioTextToSpeechCapabilityImpl implements
    TextToSpeechCapability<ClientTextToSpeechRequest>,
    TextToSpeechStreamCapability<ClientTextToSpeechRequest> {

    /**
     * Creates a new Mistral TTS capability delegate.
     *
     * @param {BaseProvider} provider Owning provider instance used for initialization checks and merged config access.
     * @param {Mistral} client Initialized official Mistral SDK client.
     * @returns {void}
     */
    constructor(
        private readonly provider: BaseProvider,
        private readonly client: Mistral
    ) { }

    /**
     * Synthesizes speech in a single non-streaming request.
     *
     * @param {AIRequest<ClientTextToSpeechRequest>} request Unified TTS request envelope.
     * @param {MultiModalExecutionContext} _ctx Optional multimodal execution context. Unused directly in this adapter.
     * @param {AbortSignal} [signal] Optional cancellation signal.
     * @throws {Error} When aborted before execution, input text is empty, or neither request/config voice nor `refAudio` is available.
     * @returns {Promise<AIResponse<NormalizedAudio[]>>} Provider-normalized synthesized audio artifact.
     */
    async textToSpeech(
        request: AIRequest<ClientTextToSpeechRequest>,
        _ctx?: MultiModalExecutionContext,
        signal?: AbortSignal
    ): Promise<AIResponse<NormalizedAudio[]>> {
        this.provider.ensureInitialized();

        if (signal?.aborted) {
            throw new Error("Text-to-speech request aborted before execution");
        }

        const { input, options, context } = request;
        // TTS requires source text; fail fast before any provider call.
        if (typeof input.text !== "string" || input.text.trim().length === 0) {
            throw new Error("TTS text must be a non-empty string");
        }

        const merged = this.provider.getMergedOptions(CapabilityKeys.AudioTextToSpeechCapabilityKey, options);
        const model = (merged.model ?? DEFAULT_MISTRAL_TTS_MODEL) as string;
        // Mistral accepts provider-specific format tokens; we resolve a best-effort
        // value locally and let the provider reject unsupported ones.
        const format = this.resolveFormat(input.format, merged.modelParams?.responseFormat);
        const speechRequest = this.buildSpeechRequest(model, input, merged.modelParams, false, format);

        const response = await this.client.audio.speech.complete(speechRequest, {
            signal,
            ...(merged.modelParams ?? {}),
            ...(merged.providerParams ?? {})            
        });

        if (!this.isSpeechResponse(response)) {
            throw new Error("Mistral TTS returned a streaming response for a non-streaming request");
        }

        // Read full payload for non-streaming path, then normalize to a single artifact.
        const artifact = createAudioArtifact({
            kind: "tts",
            id: context?.requestId ?? crypto.randomUUID(),
            mimeType: getMimeTypeForExtensionOrFormat(format, "audio/mpeg")!,
            base64: response.audioData
        });

        return {
            output: [artifact],
            multimodalArtifacts: { tts: [artifact] },
            id: artifact.id,
            rawResponse: response,
            metadata: {
                ...(context?.metadata ?? {}),
                provider: AIProvider.Mistral,
                model,
                status: "completed",
                requestId: context?.requestId
            }
        };
    }

    /**
     * Streams synthesized speech as incremental audio chunks plus a final full artifact.
     *
     * @param {AIRequest<ClientTextToSpeechRequest>} request Unified TTS request envelope.
     * @param {MultiModalExecutionContext} _ctx Optional multimodal execution context. Unused directly in this adapter.
     * @param {AbortSignal} [signal] Optional cancellation signal.
     * @throws {Error} When aborted before execution or the input text is empty.
     * @returns {AsyncGenerator<AIResponseChunk<NormalizedAudio[]>>} Async generator of streamed audio chunks and the final artifact.
     */
    async *textToSpeechStream(
        request: AIRequest<ClientTextToSpeechRequest>,
        _ctx?: MultiModalExecutionContext,
        signal?: AbortSignal
    ): AsyncGenerator<AIResponseChunk<NormalizedAudio[]>> {
        this.provider.ensureInitialized();

        if (signal?.aborted) {
            throw new Error("Text-to-speech request aborted before execution");
        }

        const { input, options, context } = request;
        // TTS requires source text; fail fast before any provider call.
        if (typeof input.text !== "string" || input.text.trim().length === 0) {
            throw new Error("TTS text must be a non-empty string");
        }

        const responseId = context?.requestId ?? crypto.randomUUID();
        const merged = this.provider.getMergedOptions(CapabilityKeys.AudioTextToSpeechCapabilityKey, options);
        const model = (merged.model ?? DEFAULT_MISTRAL_TTS_MODEL) as string;
        // Mistral accepts provider-specific format tokens; we resolve a best-effort
        // value locally and let the provider reject unsupported ones.
        const format = this.resolveFormat(input.format, merged.modelParams?.responseFormat);
        const speechRequest = this.buildSpeechRequest(model, input, merged.modelParams, false, format);        

        try {
            const response = await this.client.audio.speech.complete(speechRequest, {
                signal,
                ...(merged.modelParams ?? {}),
                ...(merged.providerParams ?? {}) 
            });

            if (this.isSpeechResponse(response)) {
                throw new Error("Mistral TTS stream returned a non-streaming response");
            }

            const chunks: Buffer[] = [];
            let finalUsage: UsageInfoDollarDefs | undefined;
            let chunkIndex = 0;

            // Mistral streaming TTS arrives as typed SSE events, not a raw byte stream,
            // so we rebuild the full audio payload from per-event base64 deltas.
            for await (const event of response) {
                if (signal?.aborted) {
                    return;
                }

                // `speech.audio.delta` carries incremental audio and `speech.audio.done`
                // closes the stream with optional usage metadata.
                if (event.data.type === "speech.audio.delta") {
                    const bytes = Buffer.from(event.data.audioData, "base64");
                    chunks.push(bytes);

                    const artifact = createAudioArtifact({
                        kind: "tts",
                        id: `${responseId}-chunk-${chunkIndex++}`,
                        mimeType: getMimeTypeForExtensionOrFormat(format, "audio/mpeg")!,
                        base64: event.data.audioData
                    });

                    yield {
                        done: false,
                        id: responseId,
                        delta: [artifact],
                        output: [artifact],
                        metadata: {
                            ...(context?.metadata ?? {}),
                            provider: AIProvider.Mistral,
                            model,
                            status: "incomplete",
                            requestId: context?.requestId
                        }
                    };
                    continue;
                }

                if (event.data.type === "speech.audio.done") {
                    finalUsage = event.data.usage;
                }
            }
            
            // Final completion chunk carries the full audio payload for single-artifact consumers.
            const finalArtifact = createAudioArtifact({
                kind: "tts",
                id: responseId,
                mimeType: getMimeTypeForExtensionOrFormat(format, "audio/mpeg")!,
                base64: Buffer.concat(chunks).toString("base64")
            });

            yield {
                done: true,
                id: responseId,
                output: [finalArtifact],
                multimodalArtifacts: { tts: [finalArtifact] },
                metadata: {
                    ...(context?.metadata ?? {}),
                    provider: AIProvider.Mistral,
                    model,
                    status: "complete",
                    requestId: context?.requestId,
                    ...(typeof finalUsage?.totalTokens === "number" ? { totalTokens: finalUsage.totalTokens } : {})
                }
            };
        } catch (err) {
            if (signal?.aborted) {
                return;
            }

            yield {
                output: [],
                delta: [],
                done: true,
                id: responseId,
                metadata: {
                    ...(context?.metadata ?? {}),
                    provider: AIProvider.Mistral,
                    model,
                    status: "error",
                    requestId: context?.requestId,                    
                    error: err instanceof Error ? err.message : String(err)
                }
            };
        }
    }

    /**
     * Builds a Mistral speech request.
     *
     * @param {string} model Resolved model name.
     * @param {ClientTextToSpeechRequest} input Original client request input.
     * @param {Record<string, unknown> | undefined} modelParams Provider/model-specific overrides.
     * @param {boolean} stream Whether to request streamed audio output.
     * @param {string} format Resolved output format.
     * @throws {Error} When neither request/config `voiceId` nor `refAudio` is available.
     * @returns {SpeechRequest} SDK-compatible speech request.
     */
    private buildSpeechRequest(
        model: string,
        input: ClientTextToSpeechRequest,
        modelParams: Record<string, unknown> | undefined,
        stream: boolean,
        format: string
    ): SpeechRequest {
        const configuredVoiceId = typeof modelParams?.voiceId === "string" ? modelParams.voiceId : undefined;
        const refAudio = typeof modelParams?.refAudio === "string" ? modelParams.refAudio : undefined;
        const voiceId = input.voice ?? configuredVoiceId;

        if (!voiceId && !refAudio) {
            throw new Error("Mistral TTS requires request.voice, modelParams.voiceId, or modelParams.refAudio");
        }

        // Keep provider-specific extras, but do not let generic modelParams override
        // normalized fields like model/input/stream/voiceId/responseFormat.
        const passthrough = this.getAdditionalSpeechParams(modelParams);

        return {
            ...passthrough,
            model,
            input: input.text,
            stream,
            responseFormat: format as SpeechRequest["responseFormat"],
            ...(voiceId ? { voiceId } : {}),
            ...(refAudio ? { refAudio } : {})
        };
    }

    /**
     * Returns provider-specific model params that are safe to forward to Mistral
     * without overriding normalized request fields.
     *
     * @param {Record<string, unknown> | undefined} modelParams Provider/model-specific runtime params.
     * @returns {Record<string, unknown>} Forwardable provider-specific params.
     */
    private getAdditionalSpeechParams(modelParams: Record<string, unknown> | undefined): Record<string, unknown> {
        if (!modelParams) {
            return {};
        }

        const { 
            voiceId: _voiceId, 
            refAudio: _refAudio, 
            responseFormat: _responseFormat, 
            model: _model, 
            input: _input, 
            stream: _stream, 
            ...rest } = modelParams;
        return rest;
    }

    /**
     * Resolves the output format from request input and merged model defaults.
     *
     * @param {string | undefined} requestFormat Format requested by the caller.
     * @param {unknown} configuredFormat Provider/model default format from merged options.
     * @returns {string} Resolved provider format token.
     */
    private resolveFormat(requestFormat: string | undefined, configuredFormat: unknown): string {
        if (typeof requestFormat === "string" && requestFormat.trim().length > 0) {
            return requestFormat;
        }
        if (typeof configuredFormat === "string" && configuredFormat.trim().length > 0) {
            return configuredFormat;
        }
        // Match the other TTS adapters by defaulting locally when neither the
        // request nor config specifies a format.
        return "mp3";
    }

    /**
     * Runtime guard distinguishing non-streaming TTS responses from streamed event iterables.
     *
     * @param {SpeechResponse | AsyncIterable<SpeechStreamEvents>} response SDK response value.
     * @returns {response is SpeechResponse} True when the response is a non-streaming payload.
     */
    private isSpeechResponse(response: SpeechResponse | AsyncIterable<SpeechStreamEvents>): response is SpeechResponse {
        return typeof (response as SpeechResponse).audioData === "string";
    }
}
