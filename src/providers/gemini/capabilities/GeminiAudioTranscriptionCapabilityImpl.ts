import { GoogleGenAI } from "@google/genai";
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
    extractResponseIdByKeys,
    MultiModalExecutionContext,
    NormalizedAudio
} from "#root/index.js";
import {
    buildAudioContents,
    buildMetadata,
    extractGeminiText,
    extractUsage,
    normalizeAudioInput,
    stripModelPrefix
} from "./shared/GeminiAudioUtils.js";

const DEFAULT_TRANSCRIPTION_MODEL = "gemini-2.5-flash";
const DEFAULT_TRANSCRIPTION_PROMPT = "Transcribe the provided audio. Return plain text only.";
const DEFAULT_AUDIO_STREAM_BATCH_SIZE = 64;

/**
 * Gemini audio transcription adapter.
 *
 * Keeps transcription and transcription-streaming in a dedicated capability file
 * while delegating behavior to the shared Gemini audio implementation.
 */
export class GeminiAudioTranscriptionCapabilityImpl implements
    AudioTranscriptionCapability<ClientAudioTranscriptionRequest, NormalizedAudio[]>,
    AudioTranscriptionStreamCapability<ClientAudioTranscriptionRequest, NormalizedAudio[]> {

    constructor(
        private readonly provider: BaseProvider,
        private readonly client: GoogleGenAI
    ) { }

    /**
     * Non-streaming audio transcription.
     *
     * Converts input audio to inline base64, prompts Gemini for transcript text,
     * and returns a normalized transcription artifact.
     *
     * @param request Unified audio transcription request
     * @param _executionContext Optional execution context (unused)
     * @param signal Optional abort signal
     * @returns Normalized transcription artifact response
     * @throws Error if input file is missing or request is aborted
     */
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

        const merged = this.provider.getMergedOptions(
            CapabilityKeys.AudioTranscriptionCapabilityKey,
            options
        );

        const audio = await normalizeAudioInput(input.file, input.mimeType, input.filename);
        // Gemini expects inline audio bytes in the request payload.
        const response = await this.client.models.generateContent({
            model: stripModelPrefix(merged.model ?? DEFAULT_TRANSCRIPTION_MODEL),
            contents: buildAudioContents(input.prompt ?? DEFAULT_TRANSCRIPTION_PROMPT, audio),
            config: {
                ...(merged.modelParams ?? {})
            },
            ...(merged.providerParams ?? {})
        });

        if (signal?.aborted) {
            throw new Error("Request aborted");
        }

        const transcript = extractGeminiText(response);
        const artifactId = extractResponseIdByKeys(response, ["responseId", "id"]) ?? context?.requestId ?? crypto.randomUUID();
        const output = [createTranscriptionAudioArtifact(audio.mimeType, transcript, input.language, artifactId)];

        return {
            output,
            multimodalArtifacts: { audio: output },
            rawResponse: response,
            id: extractResponseIdByKeys(response, ["responseId", "id"]) ?? context?.requestId ?? crypto.randomUUID(),
            metadata: buildMetadata(context, merged.model, "completed", extractUsage(response))
        };
    }

    /**
     * Streaming audio transcription.
     *
     * Uses Gemini text stream transport and batches delta text into
     * incremental transcription chunks. Emits a terminal chunk with
     * `multimodalArtifacts.audio`.
     *
     * @param request Unified audio transcription request
     * @param _executionContext Optional execution context (unused)
     * @param signal Optional abort signal
     * @returns Async stream of normalized transcription chunks
     * @throws Error if input file is missing
     */
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

        const merged = this.provider.getMergedOptions(
            CapabilityKeys.AudioTranscriptionStreamCapabilityKey,
            options);

        const audio = await normalizeAudioInput(input.file, input.mimeType, input.filename);
        const batchSize = Number(merged?.generalParams?.audioStreamBatchSize ?? DEFAULT_AUDIO_STREAM_BATCH_SIZE);
        const requestId = context?.requestId ?? crypto.randomUUID();
        const artifactId = crypto.randomUUID();
        let responseId: string | undefined;
        let accumulatedText = "";
        let buffer = "";

        try {
            // Gemini streams text tokens; audio stays in request input only.
            const stream = await this.client.models.generateContentStream({
                model: stripModelPrefix(merged.model ?? DEFAULT_TRANSCRIPTION_MODEL),
                contents: buildAudioContents(input.prompt ?? DEFAULT_TRANSCRIPTION_PROMPT, audio),
                config: {
                    ...(merged.modelParams ?? {})
                },
                ...(merged.providerParams ?? {})
            });

            for await (const chunk of stream) {
                if (signal?.aborted) {
                    return;
                }

                responseId ??= chunk.responseId;
                const delta = chunk.text ?? "";
                if (!delta) {
                    continue;
                }

                buffer += delta;
                accumulatedText += delta;

                if (buffer.length >= batchSize) {
                    const deltaArtifact = createTranscriptionAudioArtifact(audio.mimeType, buffer, input.language, artifactId);
                    yield {
                        delta: [deltaArtifact],
                        done: false,
                        id: responseId ?? requestId,
                        metadata: buildMetadata(context, merged.model, "incomplete", undefined, requestId)
                    };
                    buffer = "";
                }
            }

            if (buffer.length > 0) {
                const deltaArtifact = createTranscriptionAudioArtifact(audio.mimeType, buffer, input.language, artifactId);
                yield {
                    delta: [deltaArtifact],
                    done: false,
                    id: responseId ?? requestId,
                    metadata: buildMetadata(context, merged.model, "incomplete", undefined, requestId)
                };
            }

            const finalArtifact = createTranscriptionAudioArtifact(audio.mimeType, accumulatedText, input.language, artifactId);
            yield {
                delta: [finalArtifact],
                output: [finalArtifact],
                done: true,
                id: responseId ?? requestId,
                multimodalArtifacts: { audio: [finalArtifact] },
                metadata: buildMetadata(context, merged.model, "completed", undefined, requestId)
            };
        } catch (err) {
            if (signal?.aborted) {
                return;
            }

            yield {
                done: true,
                id: responseId ?? requestId,
                error: err instanceof Error ? err.message : String(err),
                metadata: buildMetadata(context, merged.model, "error", undefined, requestId, {
                    audioErrorCode: extractAudioErrorCode(err)
                })
            };
        }
    }
}
