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
    MultiModalExecutionContext,
    NormalizedAudio,
    TextToSpeechCapability,
    TextToSpeechStreamCapability
} from "#root/index.js";

const DEFAULT_MISTRAL_TTS_MODEL = "voxtral-mini-tts-2603";
const DEFAULT_MISTRAL_TTS_FORMAT = "mp3";
const MISTRAL_SUPPORTED_TTS_FORMATS = new Set(["mp3", "wav", "pcm", "flac", "opus"]);

const FORMAT_TO_MIME: Record<string, string> = {
    mp3: "audio/mpeg",
    wav: "audio/wav",
    pcm: "audio/pcm",
    flac: "audio/flac",
    opus: "audio/opus"
};

/**
 * Mistral text-to-speech capability implementation.
 *
 * Mistral TTS uses the dedicated `audio.speech.complete(...)` API and supports:
 * - non-streaming synthesis returning base64 audio
 * - streaming synthesis returning incremental base64 audio deltas
 *
 * Current PPAI request mapping supports:
 * - `voice` -> `voice_id`
 * - `modelParams.voiceId` for project-level default voice configuration
 * - optional `modelParams.refAudio` for advanced callers using one-off reference audio
 *
 * @public
 * @description Provider capability implementation for MistralAudioTextToSpeechCapabilityImpl.
 */
export class MistralAudioTextToSpeechCapabilityImpl
    implements TextToSpeechCapability<ClientTextToSpeechRequest>, TextToSpeechStreamCapability<ClientTextToSpeechRequest>
{
    /**
     * Creates a new Mistral TTS capability delegate.
     *
     * @param {BaseProvider} provider Owning provider instance used for initialization checks and merged config access.
     * @param {Mistral} client Initialized official Mistral SDK client.
     */
    constructor(
        private readonly provider: BaseProvider,
        private readonly client: Mistral
    ) {}

    /**
     * Synthesizes speech in a single non-streaming request.
     *
     * @param {AIRequest<ClientTextToSpeechRequest>} request Unified TTS request envelope.
     * @param {MultiModalExecutionContext} _executionContext Optional execution context. Unused directly in this adapter.
     * @param {AbortSignal} [signal] Optional cancellation signal.
     * @throws {Error} When the input text is empty, format is unsupported, or neither request/config voice nor `refAudio` is available.
     * @returns {Promise<AIResponse<NormalizedAudio[]>>} Provider-normalized synthesized audio artifact.
     */
    async textToSpeech(
        request: AIRequest<ClientTextToSpeechRequest>,
        _executionContext?: MultiModalExecutionContext,
        signal?: AbortSignal
    ): Promise<AIResponse<NormalizedAudio[]>> {
        this.provider.ensureInitialized();

        if (signal?.aborted) {
            throw new Error("Text-to-speech request aborted before execution");
        }

        const { input, options, context } = request;
        if (typeof input.text !== "string" || input.text.trim().length === 0) {
            throw new Error("TTS text must be a non-empty string");
        }

        const merged = this.provider.getMergedOptions(CapabilityKeys.AudioTextToSpeechCapabilityKey, options);
        const model = merged.model ?? DEFAULT_MISTRAL_TTS_MODEL;
        const format = this.resolveFormat(input.format, merged.modelParams?.responseFormat);
        const speechRequest = this.buildSpeechRequest(model, input, merged.modelParams, false, format);
        const response = await this.client.audio.speech.complete(speechRequest, {
            signal,
            ...(merged.providerParams ?? {})
        });

        if (!this.isSpeechResponse(response)) {
            throw new Error("Mistral TTS returned a streaming response for a non-streaming request");
        }

        const artifact = createAudioArtifact({
            kind: "tts",
            id: context?.requestId ?? crypto.randomUUID(),
            mimeType: FORMAT_TO_MIME[format],
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
     * @param {MultiModalExecutionContext} _executionContext Optional execution context. Unused directly in this adapter.
     * @param {AbortSignal} [signal] Optional cancellation signal.
     * @throws {Error} When the input text is empty, format is unsupported, or Mistral does not return a stream for a streaming request.
     * @returns {AsyncGenerator<AIResponseChunk<NormalizedAudio[]>>} Async generator of streamed audio chunks and the final artifact.
     */
    async *textToSpeechStream(
        request: AIRequest<ClientTextToSpeechRequest>,
        _executionContext?: MultiModalExecutionContext,
        signal?: AbortSignal
    ): AsyncGenerator<AIResponseChunk<NormalizedAudio[]>> {
        this.provider.ensureInitialized();

        const { input, options, context } = request;
        if (typeof input.text !== "string" || input.text.trim().length === 0) {
            throw new Error("TTS text must be a non-empty string");
        }

        const merged = this.provider.getMergedOptions(CapabilityKeys.AudioTextToSpeechStreamCapabilityKey, options);
        const model = merged.model ?? DEFAULT_MISTRAL_TTS_MODEL;
        const format = this.resolveFormat(input.format, merged.modelParams?.responseFormat);
        const response = await this.client.audio.speech.complete(
            this.buildSpeechRequest(model, input, merged.modelParams, true, format),
            { signal, ...(merged.providerParams ?? {}) }
        );

        if (this.isSpeechResponse(response)) {
            throw new Error("Mistral TTS stream returned a non-streaming response");
        }

        const responseId = context?.requestId ?? crypto.randomUUID();
        const chunks: Buffer[] = [];
        let finalUsage: UsageInfoDollarDefs | undefined;
        let chunkIndex = 0;

        for await (const event of response) {
            if (signal?.aborted) {
                return;
            }

            if (event.data.type === "speech.audio.delta") {
                const bytes = Buffer.from(event.data.audioData, "base64");
                chunks.push(bytes);

                const artifact = createAudioArtifact({
                    kind: "tts",
                    id: `${responseId}-chunk-${chunkIndex++}`,
                    mimeType: FORMAT_TO_MIME[format],
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

        const finalArtifact = createAudioArtifact({
            kind: "tts",
            id: responseId,
            mimeType: FORMAT_TO_MIME[format],
            base64: Buffer.concat(chunks).toString("base64")
        });

        yield {
            done: true,
            id: responseId,
            output: [finalArtifact],
            metadata: {
                ...(context?.metadata ?? {}),
                provider: AIProvider.Mistral,
                model,
                status: "completed",
                requestId: context?.requestId,
                ...(typeof finalUsage?.totalTokens === "number" ? { totalTokens: finalUsage.totalTokens } : {})
            }
        };
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

        return {
            model,
            input: input.text,
            stream,
            responseFormat: format as SpeechRequest["responseFormat"],
            ...(voiceId ? { voiceId } : {}),
            ...(refAudio ? { refAudio } : {}),
            ...(modelParams ?? {})
        };
    }

    /**
     * Resolves the caller-requested output format and validates it against Mistral's supported formats.
     *
     * @param {string | undefined} requestFormat Format from the client request.
     * @param {unknown} configuredFormat Format override from merged model params.
     * @throws {Error} When the resolved format is unsupported by Mistral.
     * @returns {string} Supported output format.
     */
    private resolveFormat(requestFormat: string | undefined, configuredFormat: unknown): string {
        const format = requestFormat ?? (typeof configuredFormat === "string" ? configuredFormat : DEFAULT_MISTRAL_TTS_FORMAT);
        if (!MISTRAL_SUPPORTED_TTS_FORMATS.has(format)) {
            throw new Error(`Unsupported Mistral TTS format: ${format}`);
        }
        return format;
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
