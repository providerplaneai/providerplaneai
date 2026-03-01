import OpenAI from "openai";
import {
    AIProvider,
    AIRequest,
    AIResponse,
    AIResponseChunk,
    BaseProvider,
    CapabilityKeys,
    ClientAudioTranscriptionRequest,
    ClientAudioTranslationRequest,
    ClientTextToSpeechRequest,
    AudioTranscriptionCapability,
    AudioTranscriptionStreamCapability,
    AudioTranslationCapability,
    TextToSpeechCapability,
    TextToSpeechStreamCapability,
    MultiModalExecutionContext,
    NormalizedAudio,
    AudioCapabilityError,
    assertAudioBytesWithinLimit,
    createAudioArtifact,
    decodeBase64Audio,
    extractAudioMimeInfo,
    resolveAudioInputMimeType,
    resolveAudioOutputMimeType
} from "#root/index.js";

const DEFAULT_TRANSCRIPTION_MODEL = "gpt-4o-transcribe";
const DEFAULT_TRANSLATION_MODEL = "whisper-1";
const DEFAULT_TTS_MODEL = "gpt-4o-mini-tts";
const DEFAULT_MAX_TTS_OUTPUT_BYTES = 8_388_608;
const DEFAULT_TTS_VOICE = "alloy";

/**
 * OpenAI audio capability adapter.
 *
 * Keeps OpenAI request/response shapes isolated and returns normalized audio artifacts
 * for the rest of the orchestration stack.
 */
export class OpenAIAudioCapabilityImpl
    implements
        AudioTranscriptionCapability<ClientAudioTranscriptionRequest, NormalizedAudio[]>,
        AudioTranscriptionStreamCapability<ClientAudioTranscriptionRequest, NormalizedAudio[]>,
        AudioTranslationCapability<ClientAudioTranslationRequest, NormalizedAudio[]>,
        TextToSpeechCapability<ClientTextToSpeechRequest, NormalizedAudio[]>,
        TextToSpeechStreamCapability<ClientTextToSpeechRequest, NormalizedAudio[]>
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

        const { input, options, context } = request;
        if (!input?.file) {
            throw new Error("Audio transcription requires an input file");
        }

        const merged = this.getMergedOptions(
            CapabilityKeys.AudioTranscriptionCapabilityKey,
            options,
            DEFAULT_TRANSCRIPTION_MODEL
        );
        const inputMimeType = resolveAudioInputMimeType(input.file, input.mimeType, input.filename);

        const response = await this.client.audio.transcriptions.create(
            {
                file: input.file as any,
                model: merged.model ?? DEFAULT_TRANSCRIPTION_MODEL,
                language: input.language,
                prompt: input.prompt,
                temperature: input.temperature,
                include: input.include as any,
                stream: input.stream as any,
                response_format: (input.responseFormat as any) ?? "json",
                ...(input.knownSpeakerNames?.length ? { known_speaker_names: input.knownSpeakerNames } : {}),
                ...(merged.modelParams ?? {}),
                ...(merged.providerParams ?? {})
            },
            { signal }
        );

        const transcript = typeof response === "string" ? response : (response as any).text;
        const usage = (response as any)?.usage;
        const inputAudioInfo = this.extractAudioMimeInfo(inputMimeType);
        const artifactId = this.extractResponseId(response) ?? context?.requestId ?? crypto.randomUUID();
        const output = [
            {
                id: artifactId,
                kind: "transcription",
                mimeType: inputMimeType,
                transcript,
                language: (response as any)?.language ?? input.language,
                durationSeconds:
                    (response as any)?.duration ??
                    ((usage as any)?.type === "duration" ? (usage as any)?.seconds : undefined) ??
                    this.inferDurationSeconds(this.extractSegments(response), this.extractWords(response)),
                segments: this.extractSegments(response),
                words: this.extractWords(response),
                sampleRateHz: inputAudioInfo.sampleRateHz,
                channels: inputAudioInfo.channels,
                bitrate: inputAudioInfo.bitrate
            } satisfies NormalizedAudio
        ];

        return {
            output,
            multimodalArtifacts: { audio: output },
            rawResponse: response,
            id: this.extractResponseId(response) ?? context?.requestId ?? crypto.randomUUID(),
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

        const merged = this.getMergedOptions(
            CapabilityKeys.AudioTranscriptionStreamCapabilityKey,
            options,
            DEFAULT_TRANSCRIPTION_MODEL
        );

        const batchSize = Number(merged?.generalParams?.audioStreamBatchSize ?? 64);
        const requestId = context?.requestId ?? crypto.randomUUID();
        const artifactId = crypto.randomUUID();
        const mimeType = resolveAudioInputMimeType(input.file, input.mimeType, input.filename);
        let responseId: string | undefined;
        let accumulatedText = "";
        let buffer = "";

        try {
            // NOTE: The SDK return type can vary by model/params; runtime guard below handles both.
            const streamOrResponse = (await this.client.audio.transcriptions.create(
                {
                    file: input.file as any,
                    model: merged.model ?? DEFAULT_TRANSCRIPTION_MODEL,
                    language: input.language,
                    prompt: input.prompt,
                    temperature: input.temperature,
                    include: input.include as any,
                    stream: true,
                    response_format: (input.responseFormat as any) ?? "text",
                    ...(input.knownSpeakerNames?.length ? { known_speaker_names: input.knownSpeakerNames } : {}),
                    ...(merged.modelParams ?? {}),
                    ...(merged.providerParams ?? {})
                },
                { signal }
            )) as unknown;

            if (!this.isAsyncIterable(streamOrResponse)) {
                // Fallback path: treat as non-stream response and emit one terminal chunk.
                const transcript =
                    typeof streamOrResponse === "string" ? streamOrResponse : ((streamOrResponse as any)?.text ?? "");
                const finalArtifact = this.createTranscriptionArtifact(artifactId, mimeType, transcript, input.language);

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

                // Some event variants include response id on top-level id, others nested under response.id.
                const eventId = this.extractEventResponseId(event);
                if (!responseId && eventId) {
                    responseId = eventId;
                }

                // Normalize multiple event payload shapes into a text delta.
                const delta = this.extractTranscriptionDelta(event);
                if (delta) {
                    buffer += delta;
                    accumulatedText += delta;
                }

                // Emit batched chunk once threshold is met.
                if (buffer.length >= batchSize) {
                    const deltaArtifact = this.createTranscriptionArtifact(artifactId, mimeType, buffer, input.language);
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
            }

            if (buffer.length > 0) {
                const deltaArtifact = this.createTranscriptionArtifact(artifactId, mimeType, buffer, input.language);
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

            const finalArtifact = this.createTranscriptionArtifact(artifactId, mimeType, accumulatedText, input.language);
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
            const audioErrorCode = this.extractAudioErrorCode(err);
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

    async translateAudio(
        request: AIRequest<ClientAudioTranslationRequest>,
        _executionContext?: MultiModalExecutionContext,
        signal?: AbortSignal
    ): Promise<AIResponse<NormalizedAudio[]>> {
        this.provider.ensureInitialized();

        const { input, options, context } = request;
        if (!input?.file) {
            throw new Error("Audio translation requires an input file");
        }
        if (
            input.targetLanguage &&
            input.targetLanguage.toLowerCase() !== "english" &&
            input.targetLanguage.toLowerCase() !== "en"
        ) {
            throw new Error("OpenAI audio translation currently supports English as the target language");
        }

        const merged = this.getMergedOptions(CapabilityKeys.AudioTranslationCapabilityKey, options, DEFAULT_TRANSLATION_MODEL);
        const inputMimeType = resolveAudioInputMimeType(input.file, input.mimeType, input.filename);

        const response = await this.client.audio.translations.create(
            {
                file: input.file as any,
                model: merged.model ?? DEFAULT_TRANSLATION_MODEL,
                prompt: input.prompt,
                temperature: input.temperature,
                response_format: (input.responseFormat as any) ?? "json",
                ...(merged.modelParams ?? {}),
                ...(merged.providerParams ?? {})
            },
            { signal }
        );

        const transcript = typeof response === "string" ? response : (response as any).text;
        const inputAudioInfo = this.extractAudioMimeInfo(inputMimeType);
        const artifactId = this.extractResponseId(response) ?? context?.requestId ?? crypto.randomUUID();
        const output = [
            {
                id: artifactId,
                kind: "translation",
                mimeType: inputMimeType,
                transcript,
                language: (response as any)?.language ?? "en",
                durationSeconds:
                    (response as any)?.duration ??
                    this.inferDurationSeconds(this.extractSegments(response), this.extractWords(response)),
                segments: this.extractSegments(response),
                words: this.extractWords(response),
                sampleRateHz: inputAudioInfo.sampleRateHz,
                channels: inputAudioInfo.channels,
                bitrate: inputAudioInfo.bitrate
            } satisfies NormalizedAudio
        ];

        return {
            output,
            multimodalArtifacts: { audio: output },
            rawResponse: response,
            id: this.extractResponseId(response) ?? context?.requestId ?? crypto.randomUUID(),
            metadata: this.buildMetadata(context, merged.model, "completed", context?.requestId, {
                audioRetryCount: 0,
                audioFallbackUsed: false,
                audioSource: "openai-translations"
            })
        };
    }

    async textToSpeech(
        request: AIRequest<ClientTextToSpeechRequest>,
        _executionContext?: MultiModalExecutionContext,
        signal?: AbortSignal
    ): Promise<AIResponse<NormalizedAudio[]>> {
        this.provider.ensureInitialized();

        const { input, options, context } = request;
        if (!input?.text) {
            throw new Error("Text-to-speech requires input text");
        }

        const merged = this.getMergedOptions(CapabilityKeys.AudioTextToSpeechCapabilityKey, options, DEFAULT_TTS_MODEL);

        const response = await this.client.audio.speech.create(
            {
                model: merged.model ?? DEFAULT_TTS_MODEL,
                input: input.text,
                voice: input.voice ?? DEFAULT_TTS_VOICE,
                response_format: (input.format as any) ?? "mp3",
                stream_format: input.streamFormat as any,
                instructions: input.instructions,
                speed: input.speed,
                ...(merged.modelParams ?? {}),
                ...(merged.providerParams ?? {})
            },
            { signal }
        );

        const maxTtsOutputBytes = Number(merged?.generalParams?.maxTtsOutputBytes ?? DEFAULT_MAX_TTS_OUTPUT_BYTES);
        const bytes = Buffer.from(await response.arrayBuffer());
        if (bytes.length === 0) {
            throw new AudioCapabilityError("AUDIO_EMPTY_RESPONSE", "OpenAI TTS response did not contain audio bytes");
        }
        assertAudioBytesWithinLimit(bytes.length, maxTtsOutputBytes, "openai.textToSpeech");
        const base64 = bytes.toString("base64");
        const mimeType = resolveAudioOutputMimeType(input.format, response.headers.get("content-type"), "mp3");
        const outputAudioInfo = this.extractAudioMimeInfo(response.headers.get("content-type") ?? mimeType);
        const outputUrl = this.extractNonDataUrl(response);
        const artifactId = this.extractResponseId(response) ?? context?.requestId ?? crypto.randomUUID();
        const output = [
            {
                id: artifactId,
                kind: "tts",
                mimeType,
                base64,
                ...(outputUrl ? { url: outputUrl } : {}),
                sampleRateHz: outputAudioInfo.sampleRateHz,
                channels: outputAudioInfo.channels,
                bitrate: outputAudioInfo.bitrate
            } satisfies NormalizedAudio
        ];

        return {
            output,
            multimodalArtifacts: { audio: output },
            rawResponse: response,
            id: this.extractResponseId(response) ?? context?.requestId ?? crypto.randomUUID(),
            metadata: this.buildMetadata(context, merged.model, "completed", context?.requestId, {
                audioRetryCount: 0,
                audioFallbackUsed: false,
                audioSource: "openai-speech-nonstream"
            })
        };
    }

    async *textToSpeechStream(
        request: AIRequest<ClientTextToSpeechRequest>,
        _executionContext?: MultiModalExecutionContext,
        signal?: AbortSignal
    ): AsyncGenerator<AIResponseChunk<NormalizedAudio[]>> {
        this.provider.ensureInitialized();

        const { input, options, context } = request;
        if (!input?.text) {
            throw new Error("Text-to-speech requires input text");
        }

        const merged = this.getMergedOptions(CapabilityKeys.AudioTextToSpeechStreamCapabilityKey, options, DEFAULT_TTS_MODEL);

        const requestId = context?.requestId ?? crypto.randomUUID();
        const artifactId = crypto.randomUUID();
        const accumulatedChunks: Buffer[] = [];
        let totalBytes = 0;
        let responseId: string | undefined;
        const maxTtsOutputBytes = Number(merged?.generalParams?.maxTtsOutputBytes ?? DEFAULT_MAX_TTS_OUTPUT_BYTES);

        try {
            const response = await this.client.audio.speech.create(
                {
                    model: merged.model ?? DEFAULT_TTS_MODEL,
                    input: input.text,
                    voice: input.voice ?? DEFAULT_TTS_VOICE,
                    response_format: (input.format as any) ?? "mp3",
                    stream_format: (input.streamFormat as any) ?? "audio",
                    instructions: input.instructions,
                    speed: input.speed,
                    ...(merged.modelParams ?? {}),
                    ...(merged.providerParams ?? {})
                },
                { signal }
            );

            responseId = (response as any)?.id ?? undefined;
            const mimeType = resolveAudioOutputMimeType(input.format, response.headers.get("content-type"), "mp3");
            const outputAudioInfo = this.extractAudioMimeInfo(response.headers.get("content-type") ?? mimeType);
            const streamBody = (response as any).body as ReadableStream<Uint8Array> | undefined;

            if (!streamBody?.getReader) {
                // Fallback path for non-stream responses: emit one completed chunk.
                const bytes = Buffer.from(await response.arrayBuffer());
                if (bytes.length === 0) {
                    throw new AudioCapabilityError(
                        "AUDIO_EMPTY_RESPONSE",
                        "OpenAI TTS stream fallback response did not contain audio bytes"
                    );
                }
                assertAudioBytesWithinLimit(bytes.length, maxTtsOutputBytes, "openai.textToSpeechStream.fallback");
                const base64 = bytes.toString("base64");
                const finalArtifact = this.createSpeechArtifact(artifactId, mimeType, base64, this.extractNonDataUrl(response));
                finalArtifact.sampleRateHz = outputAudioInfo.sampleRateHz;
                finalArtifact.channels = outputAudioInfo.channels;
                finalArtifact.bitrate = outputAudioInfo.bitrate;

                yield {
                    delta: [finalArtifact],
                    output: [finalArtifact],
                    done: true,
                    id: responseId ?? requestId,
                    multimodalArtifacts: { audio: [finalArtifact] },
                    metadata: this.buildMetadata(context, merged.model, "completed", requestId, {
                        audioRetryCount: 0,
                        audioFallbackUsed: true,
                        audioSource: "openai-speech-stream-nonstream-fallback"
                    })
                };
                return;
            }

            const reader = streamBody.getReader();
            while (true) {
                if (signal?.aborted) {
                    await reader.cancel();
                    return;
                }

                const { done, value } = await reader.read();
                if (done) {
                    break;
                }
                if (!value || value.length === 0) {
                    continue;
                }

                const bytes = Buffer.from(value);
                accumulatedChunks.push(bytes);
                totalBytes += bytes.length;
                assertAudioBytesWithinLimit(totalBytes, maxTtsOutputBytes, "openai.textToSpeechStream");
                const deltaBase64 = bytes.toString("base64");
                const deltaArtifact = this.createSpeechArtifact(
                    artifactId,
                    mimeType,
                    deltaBase64,
                    this.extractNonDataUrl(response)
                );
                deltaArtifact.sampleRateHz = outputAudioInfo.sampleRateHz;
                deltaArtifact.channels = outputAudioInfo.channels;
                deltaArtifact.bitrate = outputAudioInfo.bitrate;

                // Delta chunk carries only incremental audio payload.
                yield {
                    delta: [deltaArtifact],
                    done: false,
                    id: responseId ?? requestId,
                    metadata: this.buildMetadata(context, merged.model, "incomplete", requestId, {
                        audioRetryCount: 0,
                        audioFallbackUsed: false,
                        audioSource: "openai-speech-stream"
                    })
                };
            }

            if (totalBytes === 0) {
                throw new AudioCapabilityError("AUDIO_EMPTY_RESPONSE", "OpenAI TTS stream produced no audio chunks");
            }
            const finalBytes = Buffer.concat(accumulatedChunks);
            const finalBase64 = finalBytes.toString("base64");
            decodeBase64Audio(finalBase64, "openai.textToSpeechStream.final");
            const finalArtifact = this.createSpeechArtifact(
                artifactId,
                mimeType,
                finalBase64,
                this.extractNonDataUrl(response)
            );
            finalArtifact.sampleRateHz = outputAudioInfo.sampleRateHz;
            finalArtifact.channels = outputAudioInfo.channels;
            finalArtifact.bitrate = outputAudioInfo.bitrate;

            yield {
                delta: [finalArtifact],
                output: [finalArtifact],
                done: true,
                id: responseId ?? requestId,
                multimodalArtifacts: { audio: [finalArtifact] },
                metadata: this.buildMetadata(context, merged.model, "completed", requestId, {
                    audioRetryCount: 0,
                    audioFallbackUsed: false,
                    audioSource: "openai-speech-stream"
                })
            };
        } catch (err) {
            const audioErrorCode = this.extractAudioErrorCode(err);
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

    /**
     * Extracts provider response id from heterogeneous stream event shapes.
     */
    private extractEventResponseId(event: unknown): string | undefined {
        const direct = event as { id?: unknown; response?: { id?: unknown } } | null;
        if (typeof direct?.id === "string") {
            return direct.id;
        }
        if (typeof direct?.response?.id === "string") {
            return direct.response.id;
        }
        return undefined;
    }

    /**
     * Runtime guard used to handle OpenAI SDK typing/runtime divergence for streaming APIs.
     */
    private isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
        return typeof (value as { [Symbol.asyncIterator]?: unknown } | null)?.[Symbol.asyncIterator] === "function";
    }

    /**
     * Normalizes transcription delta text across possible OpenAI stream event variants.
     */
    private extractTranscriptionDelta(event: unknown): string {
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
    }

    /**
     * Constructs a normalized transcription artifact.
     */
    private createTranscriptionArtifact(id: string, mimeType: string, transcript: string, language?: string): NormalizedAudio {
        const details = this.extractAudioMimeInfo(mimeType);
        return createAudioArtifact({
            id,
            kind: "transcription",
            mimeType,
            transcript,
            language,
            sampleRateHz: details.sampleRateHz,
            channels: details.channels,
            bitrate: details.bitrate
        });
    }

    /**
     * Constructs a normalized synthesized speech artifact.
     */
    private createSpeechArtifact(id: string, mimeType: string, base64: string, url?: string): NormalizedAudio {
        const details = this.extractAudioMimeInfo(mimeType);
        return createAudioArtifact({
            id,
            kind: "tts",
            mimeType,
            base64,
            url,
            sampleRateHz: details.sampleRateHz,
            channels: details.channels,
            bitrate: details.bitrate
        });
    }

    private extractAudioMimeInfo(mimeType: string | undefined): {
        sampleRateHz?: number;
        channels?: number;
        bitrate?: number;
    } {
        return extractAudioMimeInfo(mimeType);
    }

    private extractResponseId(response: unknown): string | undefined {
        if (!response || typeof response !== "object") {
            return undefined;
        }
        const direct = response as Record<string, unknown>;
        return typeof direct["id"] === "string" ? (direct["id"] as string) : undefined;
    }

    private extractAudioErrorCode(err: unknown): string | undefined {
        if (err instanceof AudioCapabilityError) {
            return err.code;
        }
        if (!(err instanceof Error) || typeof err.message !== "string") {
            return undefined;
        }
        const match = err.message.match(/\[(AUDIO_[A-Z_]+)\]/);
        return match?.[1];
    }

    private inferDurationSeconds(segments: NormalizedAudio["segments"], words: NormalizedAudio["words"]): number | undefined {
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

    private extractNonDataUrl(response: unknown): string | undefined {
        if (!response || typeof response !== "object") {
            return undefined;
        }

        const direct = response as Record<string, unknown>;
        const candidates: unknown[] = [
            direct["url"],
            direct["audio_url"],
            (direct["data"] as any)?.[0]?.url,
            (direct["output"] as any)?.[0]?.url
        ];

        for (const candidate of candidates) {
            if (typeof candidate === "string" && /^https?:\/\//i.test(candidate) && this.isLikelyAssetUrl(candidate)) {
                return candidate;
            }
        }
        return undefined;
    }

    private isLikelyAssetUrl(url: string): boolean {
        try {
            const parsed = new URL(url);
            // OpenAI SDK response.url can be the request endpoint (e.g., /v1/audio/speech), not a media asset URL.
            if (parsed.hostname === "api.openai.com" && /^\/v1\/audio\/speech\/?$/i.test(parsed.pathname)) {
                return false;
            }
            return true;
        } catch {
            return false;
        }
    }

    private getMergedOptions(capability: string, options: AIRequest<unknown>["options"] | undefined, defaultModel: string) {
        return this.provider.getMergedOptions(capability, {
            model: options?.model ?? defaultModel,
            modelParams: options?.modelParams,
            providerParams: options?.providerParams,
            generalParams: options?.generalParams
        });
    }

    private buildMetadata(
        context: AIRequest<unknown>["context"] | undefined,
        model: string | undefined,
        status: "incomplete" | "completed" | "error",
        requestId: string | undefined,
        extras?: Record<string, unknown>
    ) {
        return {
            ...(context?.metadata ?? {}),
            provider: AIProvider.OpenAI,
            model,
            status,
            requestId,
            ...(extras ?? {})
        };
    }

    /**
     * Maps provider segment payloads into normalized segment schema.
     * Returns undefined when segment-level metadata is unavailable.
     */
    private extractSegments(response: unknown): NormalizedAudio["segments"] {
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
    }

    /**
     * Maps provider word-level timing payloads into normalized schema.
     * Returns undefined when word-level metadata is unavailable.
     */
    private extractWords(response: unknown): NormalizedAudio["words"] {
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
    }
}
