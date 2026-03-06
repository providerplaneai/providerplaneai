import OpenAI from "openai";
import {
    AIRequest,
    AIResponse,
    AIResponseChunk,
    AudioTranscriptionCapability,
    AudioTranscriptionStreamCapability,
    BaseProvider,
    CapabilityKeys,
    ClientAudioTranscriptionRequest,
    createTranscriptionAudioArtifact,
    extractAudioErrorCode,
    extractAudioMimeInfo,
    extractResponseIdByKeys,
    MultiModalExecutionContext,
    NormalizedAudio,
    resolveAudioInputMimeType
} from "#root/index.js";

const DEFAULT_TRANSCRIPTION_MODEL = "gpt-4o-transcribe";
const DEFAULT_STREAM_BATCH_SIZE = 64;

/**
 * OpenAI audio transcription capability (non-streaming + streaming).
 *
 * Structure mirrors other capability impls:
 * - Public methods orchestrate flow
 * - Private methods build provider args, parse outputs, and build metadata
 */
export class OpenAIAudioTranscriptionCapabilityImpl
    implements
        AudioTranscriptionCapability<ClientAudioTranscriptionRequest, NormalizedAudio[]>,
        AudioTranscriptionStreamCapability<ClientAudioTranscriptionRequest, NormalizedAudio[]>
{
    constructor(
        private readonly provider: BaseProvider,
        private readonly client: OpenAI
    ) {}

    async transcribeAudio(
        request: AIRequest<ClientAudioTranscriptionRequest>,
        _executionContext?: MultiModalExecutionContext,
        signal?: AbortSignal
    ): Promise<AIResponse<NormalizedAudio[]>> {
        this.provider.ensureInitialized();

        if (signal?.aborted) {
            throw new Error("Audio transcription aborted before request started");
        }

        const { input, options, context } = request;
        if (!input?.file) {
            throw new Error("Audio transcription requires an input file");
        }

        const merged = this.provider.getMergedOptions(CapabilityKeys.AudioTranscriptionCapabilityKey, options);
        const inputMimeType = resolveAudioInputMimeType(input.file, input.mimeType, input.filename);

        const response = await this.client.audio.transcriptions.create(
            this.buildTranscriptionCreateArgs(input, merged, false) as any,
            { signal }
        );

        const output = this.parseNonStreamingOutput(response, input, inputMimeType, context?.requestId);
        const responseId = extractResponseIdByKeys(response, ["id"]) ?? context?.requestId ?? crypto.randomUUID();
        const usage = (response as any)?.usage;

        return {
            output,
            multimodalArtifacts: { audio: output },
            rawResponse: response,
            id: responseId,
            metadata: this.buildMetadata(context, merged.model, "completed", context?.requestId, {
                audioRetryCount: 0,
                audioFallbackUsed: false,
                audioSource: "openai-transcriptions",
                inputTokens: usage?.input_tokens,
                outputTokens: usage?.output_tokens,
                totalTokens: usage?.total_tokens
            })
        };
    }

    async *transcribeAudioStream(
        request: AIRequest<ClientAudioTranscriptionRequest>,
        _executionContext?: MultiModalExecutionContext,
        signal?: AbortSignal
    ): AsyncGenerator<AIResponseChunk<NormalizedAudio[]>> {
        this.provider.ensureInitialized();

        const { input, options, context } = request;
        if (!input?.file) {
            throw new Error("Audio transcription requires an input file");
        }

        const merged = this.provider.getMergedOptions(CapabilityKeys.AudioTranscriptionStreamCapabilityKey, options);
        const batchSize = Number(merged?.generalParams?.audioStreamBatchSize ?? DEFAULT_STREAM_BATCH_SIZE);
        const requestId = context?.requestId ?? crypto.randomUUID();
        const artifactId = crypto.randomUUID();
        const mimeType = resolveAudioInputMimeType(input.file, input.mimeType, input.filename);

        let responseId: string | undefined;
        let accumulatedText = "";
        let buffer = "";

        try {
            const streamOrResponse = (await this.client.audio.transcriptions.create(
                this.buildTranscriptionCreateArgs(input, merged, true) as any,
                { signal }
            )) as unknown;

            if (!transcriptionParsers.isAsyncIterable(streamOrResponse)) {
                const transcript =
                    typeof streamOrResponse === "string" ? streamOrResponse : ((streamOrResponse as any)?.text ?? "");
                const finalArtifact = createTranscriptionAudioArtifact(mimeType, transcript, input.language, artifactId);

                yield {
                    delta: [finalArtifact],
                    output: [finalArtifact],
                    done: true,
                    id: responseId ?? requestId,
                    multimodalArtifacts: { audio: [finalArtifact] },
                    metadata: this.buildMetadata(context, merged.model, "completed", requestId, {
                        audioRetryCount: 0,
                        audioFallbackUsed: true,
                        audioSource: "openai-transcriptions-nonstream-fallback"
                    })
                };
                return;
            }

            for await (const event of streamOrResponse) {
                if (signal?.aborted) {
                    return;
                }

                const eventId = transcriptionParsers.extractEventResponseId(event);
                if (!responseId && eventId) {
                    responseId = eventId;
                }

                const delta = transcriptionParsers.extractTranscriptionDelta(event);
                if (!delta) {
                    continue;
                }

                buffer += delta;
                accumulatedText += delta;

                if (buffer.length < batchSize) {
                    continue;
                }

                const deltaArtifact = createTranscriptionAudioArtifact(mimeType, buffer, input.language, artifactId);
                yield {
                    delta: [deltaArtifact],
                    done: false,
                    id: responseId ?? requestId,
                    metadata: this.buildMetadata(context, merged.model, "incomplete", requestId, {
                        audioRetryCount: 0,
                        audioFallbackUsed: false,
                        audioSource: "openai-transcriptions-stream"
                    })
                };
                buffer = "";
            }

            if (buffer.length > 0) {
                const deltaArtifact = createTranscriptionAudioArtifact(mimeType, buffer, input.language, artifactId);
                yield {
                    delta: [deltaArtifact],
                    done: false,
                    id: responseId ?? requestId,
                    metadata: this.buildMetadata(context, merged.model, "incomplete", requestId, {
                        audioRetryCount: 0,
                        audioFallbackUsed: false,
                        audioSource: "openai-transcriptions-stream"
                    })
                };
            }

            const finalArtifact = createTranscriptionAudioArtifact(mimeType, accumulatedText, input.language, artifactId);
            yield {
                delta: [finalArtifact],
                output: [finalArtifact],
                done: true,
                id: responseId ?? requestId,
                multimodalArtifacts: { audio: [finalArtifact] },
                metadata: this.buildMetadata(context, merged.model, "completed", requestId, {
                    audioRetryCount: 0,
                    audioFallbackUsed: false,
                    audioSource: "openai-transcriptions-stream"
                })
            };
        } catch (err) {
            const audioErrorCode = extractAudioErrorCode(err);
            yield {
                done: true,
                error: err instanceof Error ? err.message : String(err),
                id: responseId ?? requestId,
                metadata: this.buildMetadata(context, merged.model, "error", requestId, {
                    audioErrorCode
                })
            };
        }
    }

    private buildTranscriptionCreateArgs(
        input: ClientAudioTranscriptionRequest,
        merged: any,
        stream: boolean
    ): Record<string, unknown> {
        return {
            file: input.file as any,
            model: merged.model ?? DEFAULT_TRANSCRIPTION_MODEL,
            language: input.language,
            prompt: input.prompt,
            temperature: input.temperature,
            include: input.include as any,
            stream: stream ? true : (input.stream as any),
            response_format: (input.responseFormat as any) ?? (stream ? "text" : "json"),
            ...(input.knownSpeakerNames?.length ? { known_speaker_names: input.knownSpeakerNames } : {}),
            ...(merged.modelParams ?? {}),
            ...(merged.providerParams ?? {})
        };
    }

    private parseNonStreamingOutput(
        response: unknown,
        input: ClientAudioTranscriptionRequest,
        inputMimeType: string,
        requestId: string | undefined
    ): NormalizedAudio[] {
        const transcript = typeof response === "string" ? response : ((response as any).text ?? "");
        const usage = (response as any)?.usage;
        const audioInfo = extractAudioMimeInfo(inputMimeType);
        const artifactId = extractResponseIdByKeys(response, ["id"]) ?? requestId ?? crypto.randomUUID();
        const segments = transcriptionParsers.extractSegments(response);
        const words = transcriptionParsers.extractWords(response);

        return [
            {
                id: artifactId,
                kind: "transcription",
                mimeType: inputMimeType,
                transcript,
                language: (response as any)?.language ?? input.language,
                durationSeconds:
                    (response as any)?.duration ??
                    ((usage as any)?.type === "duration" ? (usage as any)?.seconds : undefined) ??
                    transcriptionParsers.inferDurationSeconds(segments, words),
                segments,
                words,
                sampleRateHz: audioInfo.sampleRateHz,
                channels: audioInfo.channels,
                bitrate: audioInfo.bitrate
            }
        ];
    }

    private buildMetadata(
        context: AIRequest<unknown>["context"] | undefined,
        model: string | undefined,
        status: "incomplete" | "completed" | "error",
        requestId: string | undefined,
        extras?: Record<string, unknown>
    ): Record<string, unknown> {
        return {
            ...(context?.metadata ?? {}),
            provider: "openai",
            model,
            status,
            requestId,
            ...(extras ?? {})
        };
    }

}

const transcriptionParsers = {
    isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
        return typeof (value as { [Symbol.asyncIterator]?: unknown } | null)?.[Symbol.asyncIterator] === "function";
    },

    extractEventResponseId(event: unknown): string | undefined {
        const direct = event as { id?: unknown; response?: { id?: unknown } } | null;
        if (typeof direct?.id === "string") {
            return direct.id;
        }
        if (typeof direct?.response?.id === "string") {
            return direct.response.id;
        }
        return undefined;
    },

    extractTranscriptionDelta(event: unknown): string {
        if (!event || typeof event !== "object") {
            return "";
        }

        const e = event as {
            delta?: unknown;
            text?: unknown;
            transcript?: unknown;
            type?: unknown;
            segment?: { text?: unknown };
        };

        if (typeof e.delta === "string") {
            return e.delta;
        }
        if (typeof e.text === "string" && e.type === "transcript.text.delta") {
            return e.text;
        }
        if (typeof e.transcript === "string" && e.type === "transcript.text.delta") {
            return e.transcript;
        }
        if (typeof e.segment?.text === "string") {
            return e.segment.text;
        }
        return "";
    },

    extractSegments(response: unknown): NormalizedAudio["segments"] {
        const segments = (response as any)?.segments;
        if (!Array.isArray(segments) || segments.length === 0) {
            return undefined;
        }

        return segments
            .filter((segment) => segment && typeof segment === "object" && typeof segment.text === "string")
            .map((segment) => ({
                id: typeof segment.id === "string" ? segment.id : undefined,
                startSeconds: typeof segment.start === "number" ? segment.start : undefined,
                endSeconds: typeof segment.end === "number" ? segment.end : undefined,
                text: segment.text as string,
                speaker: typeof segment.speaker === "string" ? segment.speaker : undefined
            }));
    },

    extractWords(response: unknown): NormalizedAudio["words"] {
        const words = (response as any)?.words;
        if (!Array.isArray(words) || words.length === 0) {
            return undefined;
        }

        return words
            .filter((word) => word && typeof word === "object" && typeof word.word === "string")
            .map((word) => ({
                word: word.word as string,
                startSeconds: typeof word.start === "number" ? word.start : undefined,
                endSeconds: typeof word.end === "number" ? word.end : undefined,
                confidence: typeof word.confidence === "number" ? word.confidence : undefined,
                speaker: typeof word.speaker === "string" ? word.speaker : undefined
            }));
    },

    inferDurationSeconds(segments: NormalizedAudio["segments"], words: NormalizedAudio["words"]): number | undefined {
        const fromSegments = segments?.reduce<number | undefined>(
            (max, seg) => (typeof seg.endSeconds === "number" ? Math.max(max ?? 0, seg.endSeconds) : max),
            undefined
        );
        if (typeof fromSegments === "number") {
            return fromSegments;
        }

        return words?.reduce<number | undefined>(
            (max, word) => (typeof word.endSeconds === "number" ? Math.max(max ?? 0, word.endSeconds) : max),
            undefined
        );
    }
};
