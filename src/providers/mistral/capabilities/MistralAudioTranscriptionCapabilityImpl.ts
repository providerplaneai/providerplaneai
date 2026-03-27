/**
 * @module providers/mistral/capabilities/MistralAudioTranscriptionCapabilityImpl.ts
 * @description Mistral audio transcription capability adapter.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { Mistral } from "@mistralai/mistralai";
import type {
    AudioTranscriptionRequest,
    AudioTranscriptionRequestStream,
    FileT,
    TranscriptionResponse,
    TranscriptionStreamEvents,
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
    NormalizedChatMessage
} from "#root/index.js";

const DEFAULT_MISTRAL_AUDIO_TRANSCRIPTION_MODEL = "voxtral-mini-latest";
const DEFAULT_AUDIO_FILENAME = "audio-input";

type ResolvedTranscriptionInput =
    | { file: FileT; fileUrl?: never }
    | { file?: never; fileUrl: string };

/**
 * Mistral audio transcription capability implementation.
 *
 * Uses Mistral's dedicated audio transcription endpoints and normalizes transcript
 * output to `NormalizedChatMessage[]` so it aligns with the rest of PPAI's audio
 * capability contracts.
 *
 * @public
 * @description Provider capability implementation for MistralAudioTranscriptionCapabilityImpl.
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
     * @param {MultiModalExecutionContext} _executionContext Optional execution context. Unused directly in this adapter.
     * @param {AbortSignal} [signal] Optional cancellation signal.
     * @throws {Error} When input is invalid or the request is aborted before execution.
     * @returns {Promise<AIResponse<NormalizedChatMessage[]>>} Provider-normalized transcript artifacts.
     */
    async transcribeAudio(
        request: AIRequest<ClientAudioTranscriptionRequest>,
        _executionContext: MultiModalExecutionContext,
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
        const resolvedInput = await this.resolveTranscriptionInput(input.file, input.filename, input.mimeType, signal);
        const response = await this.client.audio.transcriptions.complete(
            this.buildTranscriptionRequest(
                merged.model ?? DEFAULT_MISTRAL_AUDIO_TRANSCRIPTION_MODEL,
                resolvedInput,
                input,
                merged.modelParams
            ),
            { signal, ...(merged.providerParams ?? {}) }
        );

        const responseId = context?.requestId ?? crypto.randomUUID();
        const message = this.createTranscriptMessage(
            responseId,
            response.text ?? "",
            merged.model ?? response.model ?? DEFAULT_MISTRAL_AUDIO_TRANSCRIPTION_MODEL,
            "completed",
            context,
            response,
            this.extractUsage(response.usage, input.language ?? response.language ?? undefined)
        );

        return {
            output: [message],
            multimodalArtifacts: { chat: [message] },
            id: responseId,
            rawResponse: response,
            metadata: {
                ...(context?.metadata ?? {}),
                provider: AIProvider.Mistral,
                model: merged.model ?? response.model ?? DEFAULT_MISTRAL_AUDIO_TRANSCRIPTION_MODEL,
                status: "completed",
                requestId: context?.requestId,
                ...this.extractUsage(response.usage, input.language ?? response.language ?? undefined)
            }
        };
    }

    /**
     * Streams transcription deltas from Mistral and emits a final completed transcript chunk.
     *
     * @param {AIRequest<ClientAudioTranscriptionRequest>} request Unified transcription request envelope.
     * @param {MultiModalExecutionContext} _executionContext Optional execution context. Unused directly in this adapter.
     * @param {AbortSignal} [signal] Optional cancellation signal.
     * @throws {Error} When input is invalid before streaming starts.
     * @returns {AsyncGenerator<AIResponseChunk<NormalizedChatMessage[]>>} Async generator of transcript delta and completion chunks.
     */
    async *transcribeAudioStream(
        request: AIRequest<ClientAudioTranscriptionRequest>,
        _executionContext: MultiModalExecutionContext,
        signal?: AbortSignal
    ): AsyncGenerator<AIResponseChunk<NormalizedChatMessage[]>> {
        this.provider.ensureInitialized();

        const { input, options, context } = request;
        if (!input?.file) {
            throw new Error("Audio transcription requires a non-empty 'file' input");
        }

        const merged = this.provider.getMergedOptions(CapabilityKeys.AudioTranscriptionStreamCapabilityKey, options);
        const model = merged.model ?? DEFAULT_MISTRAL_AUDIO_TRANSCRIPTION_MODEL;
        const resolvedInput = await this.resolveTranscriptionInput(input.file, input.filename, input.mimeType, signal);
        const stream = await this.client.audio.transcriptions.stream(
            this.buildTranscriptionStreamRequest(model, resolvedInput, input, merged.modelParams),
            { signal, ...(merged.providerParams ?? {}) }
        );

        const responseId = context?.requestId ?? crypto.randomUUID();
        let accumulatedText = "";

        for await (const event of stream) {
            if (signal?.aborted) {
                return;
            }

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
                const outputMessage = this.createTranscriptMessage(responseId, accumulatedText, model, "incomplete", context);

                yield {
                    done: false,
                    id: responseId,
                    delta: [deltaMessage],
                    output: [outputMessage],
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

            if (event.event === "transcription.done" && event.data.type === "transcription.done") {
                accumulatedText = event.data.text ?? accumulatedText;
                const usage = this.extractUsage(event.data.usage, input.language ?? event.data.language ?? undefined);
                const message = this.createTranscriptMessage(
                    responseId,
                    accumulatedText,
                    event.data.model ?? model,
                    "completed",
                    context,
                    event,
                    usage
                );

                yield {
                    done: true,
                    id: responseId,
                    output: [message],
                    metadata: {
                        ...(context?.metadata ?? {}),
                        provider: AIProvider.Mistral,
                        model: event.data.model ?? model,
                        status: "completed",
                        requestId: context?.requestId,
                        ...usage
                    }
                };
            }
        }
    }

    /**
     * Builds a non-streaming transcription request for the Mistral SDK.
     *
     * @param {string} model Resolved model name.
     * @param {ResolvedTranscriptionInput} source Normalized audio source.
     * @param {ClientAudioTranscriptionRequest} input Original client request input.
     * @param {Record<string, unknown> | undefined} modelParams Provider/model-specific overrides.
     * @returns {AudioTranscriptionRequest} SDK-compatible transcription request.
     */
    private buildTranscriptionRequest(
        model: string,
        source: ResolvedTranscriptionInput,
        input: ClientAudioTranscriptionRequest,
        modelParams?: Record<string, unknown>
    ): AudioTranscriptionRequest {
        const contextBias = input.knownSpeakerNames?.length ? input.knownSpeakerNames : undefined;

        return {
            model,
            ...(source.file ? { file: source.file } : {}),
            ...(source.fileUrl ? { fileUrl: source.fileUrl } : {}),
            ...(input.language !== undefined ? { language: input.language } : {}),
            ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
            ...(contextBias ? { contextBias } : {}),
            stream: false,
            ...(modelParams ?? {})
        };
    }

    /**
     * Builds a streaming transcription request for the Mistral SDK.
     *
     * @param {string} model Resolved model name.
     * @param {ResolvedTranscriptionInput} source Normalized audio source.
     * @param {ClientAudioTranscriptionRequest} input Original client request input.
     * @param {Record<string, unknown> | undefined} modelParams Provider/model-specific overrides.
     * @returns {AudioTranscriptionRequestStream} SDK-compatible streaming transcription request.
     */
    private buildTranscriptionStreamRequest(
        model: string,
        source: ResolvedTranscriptionInput,
        input: ClientAudioTranscriptionRequest,
        modelParams?: Record<string, unknown>
    ): AudioTranscriptionRequestStream {
        const contextBias = input.knownSpeakerNames?.length ? input.knownSpeakerNames : undefined;

        return {
            model,
            ...(source.file ? { file: source.file } : {}),
            ...(source.fileUrl ? { fileUrl: source.fileUrl } : {}),
            ...(input.language !== undefined ? { language: input.language } : {}),
            ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
            ...(contextBias ? { contextBias } : {}),
            stream: true,
            ...(modelParams ?? {})
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
                return { fileUrl: file };
            }

            if (/^data:/i.test(file)) {
                return {
                    file: {
                        fileName: filename ?? DEFAULT_AUDIO_FILENAME,
                        content: this.dataUriToUint8Array(file)
                    }
                };
            }

            const bytes = await readFile(file);
            if (signal?.aborted) {
                throw new Error("Audio transcription request aborted while reading file input");
            }

            return {
                file: {
                    fileName: filename ?? path.basename(file),
                    content: new Uint8Array(bytes)
                }
            };
        }

        if (typeof Blob !== "undefined" && file instanceof Blob) {
            return {
                file: {
                    fileName: filename ?? this.extractBlobName(file) ?? DEFAULT_AUDIO_FILENAME,
                    content: mimeType && !file.type ? new Blob([file], { type: mimeType }) : file
                }
            };
        }

        if (typeof Buffer !== "undefined" && Buffer.isBuffer(file)) {
            return {
                file: {
                    fileName: filename ?? DEFAULT_AUDIO_FILENAME,
                    content: new Uint8Array(file)
                }
            };
        }

        if (file instanceof Uint8Array) {
            return {
                file: {
                    fileName: filename ?? DEFAULT_AUDIO_FILENAME,
                    content: file
                }
            };
        }

        if (file instanceof ArrayBuffer) {
            return {
                file: {
                    fileName: filename ?? DEFAULT_AUDIO_FILENAME,
                    content: new Uint8Array(file)
                }
            };
        }

        if (this.isNodeReadableStream(file)) {
            return {
                file: {
                    fileName: filename ?? DEFAULT_AUDIO_FILENAME,
                    content: await this.readNodeStream(file, signal)
                }
            };
        }

        throw new Error("Unsupported Mistral transcription input type");
    }

    /**
     * Reads a Node readable stream into a single `Uint8Array`.
     *
     * @param {NodeJS.ReadableStream} stream Node readable stream input.
     * @param {AbortSignal} [signal] Optional cancellation signal.
     * @throws {Error} When aborted while draining the stream.
     * @returns {Promise<Uint8Array>} Collected stream bytes.
     */
    private async readNodeStream(stream: NodeJS.ReadableStream, signal?: AbortSignal): Promise<Uint8Array> {
        const chunks: Buffer[] = [];

        for await (const chunk of stream as AsyncIterable<Buffer | Uint8Array | string>) {
            if (signal?.aborted) {
                throw new Error("Audio transcription request aborted while reading stream input");
            }

            if (typeof chunk === "string") {
                chunks.push(Buffer.from(chunk));
            } else {
                chunks.push(Buffer.from(chunk));
            }
        }

        return new Uint8Array(Buffer.concat(chunks));
    }

    /**
     * Decodes a base64 data URI into raw bytes.
     *
     * @param {string} dataUri Base64 data URI string.
     * @throws {Error} When the URI does not contain base64 payload data.
     * @returns {Uint8Array} Decoded bytes.
     */
    private dataUriToUint8Array(dataUri: string): Uint8Array {
        const match = dataUri.match(/^data:.*?;base64,(.*)$/i);
        if (!match?.[1]) {
            throw new Error("Invalid audio data URI");
        }
        return new Uint8Array(Buffer.from(match[1], "base64"));
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
            metadata: {
                ...(context?.metadata ?? {}),
                provider: AIProvider.Mistral,
                model,
                status,
                requestId: context?.requestId,
                ...(extraMetadata ?? {}),
                ...(raw !== undefined ? { raw } : {})
            }
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

    /**
     * Extracts a best-effort filename from a Blob/File-like value.
     *
     * @param {Blob} blob Blob or File instance.
     * @returns {string | undefined} Name when present.
     */
    private extractBlobName(blob: Blob): string | undefined {
        const maybeFile = blob as Blob & { name?: string };
        return typeof maybeFile.name === "string" && maybeFile.name.length > 0 ? maybeFile.name : undefined;
    }

    /**
     * Runtime guard for Node readable stream inputs.
     *
     * @param {unknown} value Candidate audio input value.
     * @returns {value is NodeJS.ReadableStream} True when the value behaves like a Node readable stream.
     */
    private isNodeReadableStream(value: unknown): value is NodeJS.ReadableStream {
        return (
            typeof value === "object" &&
            value !== null &&
            typeof (value as NodeJS.ReadableStream)[Symbol.asyncIterator] === "function"
        );
    }
}
