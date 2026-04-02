/**
 * @module providers/mistral/capabilities/MistralAudioTranscriptionCapabilityImpl.ts
 * @description Mistral audio transcription capability adapter.
 */
import { Mistral } from "@mistralai/mistralai";
import type {
    AudioTranscriptionRequest,
    AudioTranscriptionRequestStream,
    FileT,
    UsageInfo
} from "@mistralai/mistralai/models/components";
import {
    AIProvider,
    AIRequest,
    AIResponse,
    AIResponseChunk,
    AudioTranscriptionCapability,
    AudioTranscriptionStreamCapability,
    BaseProvider,
    CapabilityKeys,
    ClientAudioInputSource,
    ClientAudioTranscriptionRequest,
    MultiModalExecutionContext,
    NormalizedChatMessage,
    resolveMistralFileInput,
    buildMetadata
} from "#root/index.js";

const DEFAULT_MISTRAL_AUDIO_TRANSCRIPTION_MODEL = "voxtral-mini-latest";
const DEFAULT_AUDIO_FILENAME = "audio-input";

type ResolvedTranscriptionInput = { file: FileT; fileUrl?: never } | { file?: never; fileUrl: string };

/**
 * Adapts Mistral audio transcription endpoints into ProviderPlaneAI's normalized
 * text-message artifact surface.
 *
 * Normalizes both non-streaming and streaming transcription output to
 * `NormalizedChatMessage[]` so it aligns with the rest of the audio capability contracts.
 *
 * @public
 */
export class MistralAudioTranscriptionCapabilityImpl
    implements
        AudioTranscriptionCapability<ClientAudioTranscriptionRequest>,
        AudioTranscriptionStreamCapability<ClientAudioTranscriptionRequest>
{
    /**
     * Creates a new Mistral audio transcription delegate.
     *
     * @param {BaseProvider} provider Owning provider instance used for initialization checks and merged config access.
     * @param {Mistral} client Initialized official Mistral SDK client.
     */
    constructor(
        private readonly provider: BaseProvider,
        private readonly client: Mistral
    ) {}

    /**
     * Transcribes input audio using Mistral's non-streaming transcription endpoint.
     *
     * @param {AIRequest<ClientAudioTranscriptionRequest>} request Unified transcription request envelope.
     * @param {MultiModalExecutionContext} _ctx Optional execution context. Unused directly in this adapter.
     * @param {AbortSignal} [signal] Optional cancellation signal.
     * @throws {Error} When input is invalid or the request is aborted before execution.
     * @returns {Promise<AIResponse<NormalizedChatMessage[]>>} Provider-normalized transcript artifacts.
     */
    async transcribeAudio(
        request: AIRequest<ClientAudioTranscriptionRequest>,
        _ctx: MultiModalExecutionContext,
        signal?: AbortSignal
    ): Promise<AIResponse<NormalizedChatMessage[]>> {
        this.provider.ensureInitialized();

        if (signal?.aborted) {
            throw new Error("Audio transcription request aborted before execution");
        }

        const { input, options, context } = request;
        if (!input?.file) {
            throw new Error("Audio transcription requires a non-empty 'file' input");
        }

        const merged = this.provider.getMergedOptions(CapabilityKeys.AudioTranscriptionCapabilityKey, options);
        const model = merged.model ?? DEFAULT_MISTRAL_AUDIO_TRANSCRIPTION_MODEL;
        // Normalize all caller-supported input shapes into the two Mistral forms:
        // inline upload (`file`) or provider-fetched remote source (`fileUrl`).
        const resolvedInput = await this.resolveTranscriptionInput(input.file, input.filename, input.mimeType, signal);
        const response = await this.client.audio.transcriptions.complete(
            this.buildTranscriptionRequest(model, resolvedInput, input, false, merged.modelParams) as AudioTranscriptionRequest,
            {
                signal,
                // Keep the transport-level SDK options passthrough behavior unchanged here.
                ...(merged.providerParams ?? {})
            }
        );

        const finalUsage = this.extractUsage(response.usage, input.language ?? response.language ?? undefined);
        const responseId = context?.requestId ?? crypto.randomUUID();
        const message = this.createTranscriptMessage(
            responseId,
            response.text ?? "",
            model,
            "completed",
            context,
            response,
            finalUsage
        );

        return {
            output: [message],
            multimodalArtifacts: { chat: [message] },
            id: responseId,
            rawResponse: response,
            metadata: buildMetadata(context?.metadata, {
                provider: AIProvider.Mistral,
                model,
                status: "completed",
                requestId: context?.requestId,
                ...finalUsage
            })
        };
    }

    /**
     * Streams transcription deltas from Mistral and emits a final completed transcript chunk.
     *
     * @param {AIRequest<ClientAudioTranscriptionRequest>} request Unified transcription request envelope.
     * @param {MultiModalExecutionContext} _ctx Optional execution context. Unused directly in this adapter.
     * @param {AbortSignal} [signal] Optional cancellation signal.
     * @throws {Error} When input is invalid before streaming starts.
     * @returns {AsyncGenerator<AIResponseChunk<NormalizedChatMessage[]>>} Async generator of transcript delta and completion chunks.
     */
    async *transcribeAudioStream(
        request: AIRequest<ClientAudioTranscriptionRequest>,
        _ctx: MultiModalExecutionContext,
        signal?: AbortSignal
    ): AsyncGenerator<AIResponseChunk<NormalizedChatMessage[]>> {
        this.provider.ensureInitialized();

        if (signal?.aborted) {
            throw new Error("Audio transcription request aborted before execution");
        }

        const { input, options, context } = request;
        if (!input?.file) {
            throw new Error("Audio transcription requires a non-empty 'file' input");
        }

        const merged = this.provider.getMergedOptions(CapabilityKeys.AudioTranscriptionStreamCapabilityKey, options);
        const model = merged.model ?? DEFAULT_MISTRAL_AUDIO_TRANSCRIPTION_MODEL;
        const responseId = context?.requestId ?? crypto.randomUUID();
        let accumulatedText = "";
        let finalUsage: Record<string, unknown> | undefined;

        try {
            const resolvedInput = await this.resolveTranscriptionInput(input.file, input.filename, input.mimeType, signal);
            const stream = await this.client.audio.transcriptions.stream(
                this.buildTranscriptionRequest(
                    model,
                    resolvedInput,
                    input,
                    true,
                    merged.modelParams
                ) as AudioTranscriptionRequestStream,
                {
                    signal,
                    // Keep the transport-level SDK options passthrough behavior unchanged here.
                    ...(merged.providerParams ?? {})
                }
            );

            for await (const event of stream) {
                if (signal?.aborted) {
                    return;
                }

                // Mistral emits incremental transcript text as delta events before a terminal
                // `transcription.done` frame with the authoritative final text and usage.
                if (event.event === "transcription.text.delta" && event.data.type === "transcription.text.delta") {
                    if (!event.data.text) {
                        continue;
                    }

                    accumulatedText += event.data.text;
                    const deltaMessage = this.createTranscriptMessage(
                        `${responseId}-delta-${crypto.randomUUID()}`,
                        event.data.text,
                        model,
                        "incomplete",
                        context,
                        event
                    );
                    const outputMessage = this.createTranscriptMessage(
                        responseId,
                        accumulatedText,
                        model,
                        "incomplete",
                        context
                    );

                    yield {
                        done: false,
                        id: responseId,
                        delta: [deltaMessage],
                        output: [outputMessage],
                        metadata: buildMetadata(context?.metadata, {
                            provider: AIProvider.Mistral,
                            model,
                            status: "incomplete",
                            requestId: context?.requestId,
                            ...finalUsage
                        })
                    };
                    continue;
                }

                if (event.event === "transcription.done" && event.data.type === "transcription.done") {
                    accumulatedText = event.data.text ?? accumulatedText;
                    finalUsage = this.extractUsage(event.data.usage, input.language ?? event.data.language ?? undefined);
                    const finalModel = event.data.model ?? model;
                    const message = this.createTranscriptMessage(
                        responseId,
                        accumulatedText,
                        finalModel,
                        "completed",
                        context,
                        event,
                        finalUsage
                    );

                    yield {
                        done: true,
                        id: responseId,
                        output: [message],
                        multimodalArtifacts: { chat: [message] },
                        metadata: buildMetadata(context?.metadata, {
                            provider: AIProvider.Mistral,
                            model: finalModel,
                            status: "completed",
                            requestId: context?.requestId,
                            ...finalUsage
                        })
                    };
                    return;
                }
            }

            const fallbackMessage = this.createTranscriptMessage(
                responseId,
                accumulatedText,
                model,
                "completed",
                context,
                undefined,
                finalUsage
            );

            yield {
                done: true,
                id: responseId,
                output: [fallbackMessage],
                multimodalArtifacts: { chat: [fallbackMessage] },
                metadata: buildMetadata(context?.metadata, {
                    provider: AIProvider.Mistral,
                    model,
                    status: "completed",
                    requestId: context?.requestId,
                    ...finalUsage
                })
            };
        } catch (err) {
            if (signal?.aborted) {
                return;
            }

            yield {
                done: true,
                id: responseId,
                output: [],
                delta: [],
                metadata: buildMetadata(context?.metadata, {
                    provider: AIProvider.Mistral,
                    model,
                    status: "error",
                    requestId: context?.requestId,
                    ...(finalUsage ?? {}),
                    error: err instanceof Error ? err.message : String(err)
                })
            };
        }
    }

    /**
     * Builds a non-streaming transcription request for the Mistral SDK.
     *
     * @param {string} model Resolved model name.
     * @param {ResolvedTranscriptionInput} source Normalized audio source.
     * @param {ClientAudioTranscriptionRequest} input Original client request input.
     * @param {boolean} stream Whether the request is for streaming transcription.
     * @param {Record<string, unknown> | undefined} modelParams Provider/model-specific overrides.
     * @returns {AudioTranscriptionRequest | AudioTranscriptionRequestStream} SDK-compatible transcription request.
     */
    private buildTranscriptionRequest(
        model: string,
        source: ResolvedTranscriptionInput,
        input: ClientAudioTranscriptionRequest,
        stream: boolean = false,
        modelParams?: Record<string, unknown>
    ): AudioTranscriptionRequest | AudioTranscriptionRequestStream {
        const contextBias = input.knownSpeakerNames?.length ? input.knownSpeakerNames : undefined;

        return {
            // Preserve provider-specific extras without letting modelParams override
            // the normalized request fields this adapter already resolved.
            ...(modelParams ?? {}),
            model,
            ...(source.file ? { file: source.file } : {}),
            ...(source.fileUrl ? { fileUrl: source.fileUrl } : {}),
            ...(input.language !== undefined ? { language: input.language } : {}),
            ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
            ...(contextBias ? { contextBias } : {}),
            stream
        };
    }

    /**
     * Resolves the caller's audio input into either a direct file upload or a remote file URL.
     *
     * @param {ClientAudioInputSource} file Audio source provided by the caller.
     * @param {string} [filename] Optional filename hint.
     * @param {string} [mimeType] Optional MIME type hint.
     * @param {AbortSignal} [signal] Optional cancellation signal.
     * @throws {Error} When a local/streamed input cannot be read.
     * @returns {Promise<ResolvedTranscriptionInput>} SDK-compatible file or fileUrl payload.
     */
    private async resolveTranscriptionInput(
        file: ClientAudioInputSource,
        filename?: string,
        mimeType?: string,
        signal?: AbortSignal
    ): Promise<ResolvedTranscriptionInput> {
        if (typeof file === "string") {
            if (/^https?:\/\//i.test(file)) {
                // Remote audio can be fetched directly by Mistral without a local upload hop.
                return { fileUrl: file };
            }
        }
        return {
            file: await resolveMistralFileInput(file, {
                filenameHint: filename,
                mimeTypeHint: mimeType,
                defaultFileName: DEFAULT_AUDIO_FILENAME,
                signal,
                fileAbortMessage: "Audio transcription request aborted while reading file input",
                streamAbortMessage: "Audio transcription request aborted while reading stream input",
                unsupportedSourceMessage: "Unsupported Mistral transcription input type"
            })
        };
    }

    /**
     * Creates a normalized assistant transcript message.
     *
     * @param {string} id Message identifier.
     * @param {string} text Transcript text.
     * @param {string} model Model identifier.
     * @param {"completed" | "incomplete"} status Message status.
     * @param {AIRequest<ClientAudioTranscriptionRequest>["context"]} context Request context.
     * @param {unknown} [raw] Optional raw provider payload.
     * @param {Record<string, unknown>} [extraMetadata] Optional provider-specific metadata fields.
     * @returns {NormalizedChatMessage} Provider-normalized transcript message.
     */
    private createTranscriptMessage(
        id: string,
        text: string,
        model: string,
        status: "completed" | "incomplete",
        context?: AIRequest<ClientAudioTranscriptionRequest>["context"],
        raw?: unknown,
        extraMetadata?: Record<string, unknown>
    ): NormalizedChatMessage {
        return {
            id,
            role: "assistant",
            content: text ? [{ type: "text", text }] : [],
            metadata: buildMetadata(context?.metadata, {
                provider: AIProvider.Mistral,
                model,
                status,
                requestId: context?.requestId,
                ...(extraMetadata ?? {}),
                ...(raw !== undefined ? { raw } : {})
            })
        };
    }

    /**
     * Extracts the most useful usage metadata for normalized transcript outputs.
     *
     * @param {UsageInfo | undefined} usage SDK usage object.
     * @param {string | undefined} language Transcript language when available.
     * @returns {Record<string, unknown>} Metadata fields to merge into normalized outputs.
     */
    private extractUsage(usage?: UsageInfo, language?: string): Record<string, unknown> {
        return {
            ...(typeof usage?.promptTokens === "number" ? { promptTokens: usage.promptTokens } : {}),
            ...(typeof usage?.completionTokens === "number" ? { completionTokens: usage.completionTokens } : {}),
            ...(typeof usage?.totalTokens === "number" ? { totalTokens: usage.totalTokens } : {}),
            ...(language ? { language } : {})
        };
    }
}
