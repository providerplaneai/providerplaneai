/**
 * @module providers/gemini/capabilities/GeminiAudioTranscriptionCapabilityImpl.ts
 * @description Provider implementations and capability adapters.
 */
import { GoogleGenAI } from "@google/genai";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import {
    AIProvider,
    AIRequest,
    AIResponse,
    AIResponseChunk,
    AudioTranscriptionCapability,
    AudioTranscriptionStreamCapability,
    BaseProvider,
    CapabilityKeys,
    ClientAudioTranscriptionRequest,
    MultiModalExecutionContext,
    NormalizedChatMessage
} from "#root/index.js";

const DEFAULT_GEMINI_AUDIO_TRANSCRIPTION_MODEL = "gemini-2.5-flash";

/**
 * Gemini audio transcription capability implementation.
 *
 * Uses Gemini `models.generateContent` / `models.generateContentStream` and normalizes
 * transcripts to `NormalizedChatMessage[]` artifacts.
 */
/**
 * @public
 * @description Provider capability implementation for GeminiAudioTranscriptionCapabilityImpl.
 */
export class GeminiAudioTranscriptionCapabilityImpl
    implements
        AudioTranscriptionCapability<ClientAudioTranscriptionRequest>,
        AudioTranscriptionStreamCapability<ClientAudioTranscriptionRequest>
{
    constructor(
        private readonly provider: BaseProvider,
        private readonly client: GoogleGenAI
    ) {}

    /**
     * Transcribes audio in non-streaming mode.
     *
     * Steps:
     * - Validate input
     * - Merge provider/model options
     * - Normalize audio payload
     * - Build Gemini instruction prompt
     * - Call `generateContent` and normalize output
     *
     * @param request Unified AI request containing transcription input/options/context
     * @param _ctx Optional multimodal execution context (unused by this capability)
     * @param signal Optional abort signal
     * @returns Provider-normalized transcript messages
     * @throws {Error} If input is invalid or request is aborted
     *
     */
    async transcribeAudio(
        request: AIRequest<ClientAudioTranscriptionRequest>,
        _ctx: MultiModalExecutionContext,
        signal?: AbortSignal
    ): Promise<AIResponse<NormalizedChatMessage[]>> {
        // Ensure provider has been initialized with credentials + client.
        this.provider.ensureInitialized();

        if (signal?.aborted) {
            throw new Error("Audio transcription request aborted before execution");
        }

        const { input, options, context } = request;
        if (!input?.file) {
            throw new Error("Audio transcription requires a non-empty 'file' input");
        }

        const merged = this.provider.getMergedOptions(CapabilityKeys.AudioTranscriptionCapabilityKey, options);
        // Normalize model names to bare Gemini ids because config can include `models/` prefixes.
        const model = (merged.model ?? DEFAULT_GEMINI_AUDIO_TRANSCRIPTION_MODEL).replace(/^models\//, "");

        // Convert supported caller source shapes into Gemini inlineData payload.
        const payload = await this.resolveAudioPayload(input.file, input.mimeType);
        const instruction = this.buildTranscriptionInstruction(input.language, input.prompt, input.responseFormat);

        // Gemini transcription is prompt-driven with audio attached as inlineData.
        const response = await this.client.models.generateContent({
            model,
            contents: [
                {
                    role: "user",
                    parts: [
                        { text: instruction },
                        {
                            inlineData: {
                                mimeType: payload.mimeType,
                                data: payload.base64
                            }
                        }
                    ]
                }
            ],
            ...(merged.modelParams ?? {}),
            ...(merged.providerParams ?? {})
        } as any);

        const responseId = response?.responseId ?? context?.requestId ?? crypto.randomUUID();
        const text = this.extractTextFromGeminiResponse(response);
        const usage = this.extractUsage(response);

        const message: NormalizedChatMessage = {
            id: responseId,
            role: "assistant",
            content: text ? [{ type: "text", text }] : [],
            metadata: {
                ...(context?.metadata ?? {}),
                provider: AIProvider.Gemini,
                model,
                status: "completed",
                requestId: context?.requestId,
                language: input.language,
                ...usage
            }
        };

        return {
            // Keep top-level metadata aligned with message metadata for easier consumer logging.
            output: [message],
            multimodalArtifacts: { chat: [message] },
            id: responseId,
            rawResponse: response,
            metadata: {
                ...(context?.metadata ?? {}),
                provider: AIProvider.Gemini,
                model,
                status: "completed",
                requestId: context?.requestId,
                language: input.language,
                ...usage
            }
        };
    }

    /**
     * Transcribes audio in streaming mode and emits incremental transcript deltas.
     *
     * Emits:
     * - `done: false` chunks while transcript text accumulates
     * - a terminal `done: true` completed chunk
     * - a terminal `done: true` error chunk on failure
     *
     * @param request Unified AI request containing transcription input/options/context
     * @param _ctx Optional multimodal execution context (unused by this capability)
     * @param signal Optional abort signal
     * @returns Async generator of delta and final transcript chunks
     * @throws {Error} If input is invalid before streaming starts
     *
     */
    async *transcribeAudioStream(
        request: AIRequest<ClientAudioTranscriptionRequest>,
        _ctx: MultiModalExecutionContext,
        signal?: AbortSignal
    ): AsyncGenerator<AIResponseChunk<NormalizedChatMessage[]>> {
        // Ensure provider has been initialized with credentials + client.
        this.provider.ensureInitialized();

        const { input, options, context } = request;
        if (!input?.file) {
            throw new Error("Audio transcription requires a non-empty 'file' input");
        }

        const merged = this.provider.getMergedOptions(CapabilityKeys.AudioTranscriptionStreamCapabilityKey, options);
        const model = (merged.model ?? DEFAULT_GEMINI_AUDIO_TRANSCRIPTION_MODEL).replace(/^models\//, "");
        // Re-batch text deltas to stable chunk sizes for subscribers and UI updates.
        const batchSize = Math.max(1, Number(merged.generalParams?.audioStreamBatchSize ?? 64));

        const payload = await this.resolveAudioPayload(input.file, input.mimeType);
        const instruction = this.buildTranscriptionInstruction(input.language, input.prompt, input.responseFormat);

        let responseId: string | undefined;
        let accumulatedText = "";
        let buffer = "";
        let latestUsage: ReturnType<GeminiAudioTranscriptionCapabilityImpl["extractUsage"]> | undefined;

        try {
            if (signal?.aborted) {
                return;
            }

            const stream = await this.client.models.generateContentStream({
                model,
                contents: [
                    {
                        role: "user",
                        parts: [
                            { text: instruction },
                            {
                                inlineData: {
                                    mimeType: payload.mimeType,
                                    data: payload.base64
                                }
                            }
                        ]
                    }
                ],
                ...(merged.modelParams ?? {}),
                ...(merged.providerParams ?? {})
            } as any);

            for await (const chunk of stream) {
                if (signal?.aborted) {
                    return;
                }

                // Keep a stable response id across all emitted chunks.
                responseId ??= chunk?.responseId ?? context?.requestId ?? crypto.randomUUID();
                // Usage can vary by chunk; keep latest observed values for emitted metadata.
                latestUsage = this.extractUsage(chunk);

                const deltaText = this.extractTextFromGeminiResponse(chunk);
                // Skip non-text events/frames; Gemini can emit chunks with no transcript delta.
                if (!deltaText) {
                    continue;
                }

                buffer += deltaText;
                accumulatedText += deltaText;

                // Flush when we reach configured threshold to avoid tiny chunk spam.
                if (buffer.length >= batchSize) {
                    const deltaMessage: NormalizedChatMessage = {
                        id: `${responseId}-delta-${crypto.randomUUID()}`,
                        role: "assistant",
                        content: [{ type: "text", text: buffer }],
                        metadata: {
                            ...(context?.metadata ?? {}),
                            provider: AIProvider.Gemini,
                            model,
                            status: "incomplete",
                            requestId: context?.requestId,
                            language: input.language,
                            ...(latestUsage ?? {})
                        }
                    };

                    const outputMessage: NormalizedChatMessage = {
                        id: responseId,
                        role: "assistant",
                        content: [{ type: "text", text: accumulatedText }],
                        metadata: {
                            ...(context?.metadata ?? {}),
                            provider: AIProvider.Gemini,
                            model,
                            status: "incomplete",
                            requestId: context?.requestId,
                            language: input.language,
                            ...(latestUsage ?? {})
                        }
                    };

                    yield {
                        done: false,
                        id: responseId,
                        delta: [deltaMessage],
                        output: [outputMessage],
                        metadata: {
                            ...(context?.metadata ?? {}),
                            provider: AIProvider.Gemini,
                            model,
                            status: "incomplete",
                            requestId: context?.requestId,
                            language: input.language,
                            ...(latestUsage ?? {})
                        }
                    };

                    // Reset only flushed buffer; keep accumulatedText for final output continuity.
                    buffer = "";
                }
            }

            // Flush trailing text that did not hit batch threshold.
            if (buffer.length > 0 || accumulatedText.length > 0) {
                const deltaMessage: NormalizedChatMessage = {
                    id: `${responseId ?? context?.requestId ?? crypto.randomUUID()}-delta-${crypto.randomUUID()}`,
                    role: "assistant",
                    content: buffer ? [{ type: "text", text: buffer }] : [],
                    metadata: {
                        ...(context?.metadata ?? {}),
                        provider: AIProvider.Gemini,
                        model,
                        status: "incomplete",
                        requestId: context?.requestId,
                        language: input.language,
                        ...(latestUsage ?? {})
                    }
                };

                const outputMessage: NormalizedChatMessage = {
                    id: responseId ?? context?.requestId ?? crypto.randomUUID(),
                    role: "assistant",
                    content: accumulatedText ? [{ type: "text", text: accumulatedText }] : [],
                    metadata: {
                        ...(context?.metadata ?? {}),
                        provider: AIProvider.Gemini,
                        model,
                        status: "incomplete",
                        requestId: context?.requestId,
                        language: input.language,
                        ...(latestUsage ?? {})
                    }
                };

                yield {
                    done: false,
                    id: outputMessage.id,
                    delta: buffer ? [deltaMessage] : [],
                    output: [outputMessage],
                    metadata: {
                        ...(context?.metadata ?? {}),
                        provider: AIProvider.Gemini,
                        model,
                        status: "incomplete",
                        requestId: context?.requestId,
                        language: input.language,
                        ...(latestUsage ?? {})
                    }
                };
            }

            // Emit final completed transcript artifact.
            const finalId = responseId ?? context?.requestId ?? crypto.randomUUID();
            const finalMessage: NormalizedChatMessage = {
                id: finalId,
                role: "assistant",
                content: accumulatedText ? [{ type: "text", text: accumulatedText }] : [],
                metadata: {
                    ...(context?.metadata ?? {}),
                    provider: AIProvider.Gemini,
                    model,
                    status: "completed",
                    requestId: context?.requestId,
                    language: input.language,
                    ...(latestUsage ?? {})
                }
            };

            yield {
                done: true,
                id: finalId,
                output: [finalMessage],
                // Attach final transcript to timeline artifacts for downstream job snapshot consumers.
                multimodalArtifacts: { chat: [finalMessage] },
                metadata: {
                    ...(context?.metadata ?? {}),
                    provider: AIProvider.Gemini,
                    model,
                    status: "completed",
                    requestId: context?.requestId,
                    language: input.language,
                    ...(latestUsage ?? {})
                }
            };
        } catch (err) {
            if (signal?.aborted) {
                return;
            }

            // Streaming error contract: terminal chunk with diagnostic metadata.
            yield {
                done: true,
                id: responseId ?? context?.requestId ?? crypto.randomUUID(),
                output: [],
                delta: [],
                metadata: {
                    ...(context?.metadata ?? {}),
                    provider: AIProvider.Gemini,
                    model,
                    status: "error",
                    requestId: context?.requestId,
                    language: input.language,
                    error: err instanceof Error ? err.message : String(err),
                    ...(latestUsage ?? {})
                }
            };
        }
    }

    /**
     * Extracts Gemini token usage fields when available.
     *
     * @param response Gemini response/chunk
     * @returns Normalized usage metrics
     * @private
     */
    private extractUsage(response: any): {
        inputTokens?: number;
        outputTokens?: number;
        totalTokens?: number;
    } {
        // Gemini usage is optional on some chunk types; return empty metrics when absent.
        const usage = response?.usageMetadata;
        if (!usage) {
            return {};
        }
        return {
            inputTokens: usage.promptTokenCount,
            outputTokens: usage.candidatesTokenCount,
            totalTokens: usage.totalTokenCount
        };
    }

    /**
     * Extracts transcript text from Gemini response variants.
     *
     * @param response Gemini response/chunk
     * @returns Transcript text extracted from `response.text` or candidate parts
     * @private
     */
    private extractTextFromGeminiResponse(response: any): string {
        // Fast path: top-level convenience field exposed by the SDK.
        if (typeof response?.text === "string" && response.text.length > 0) {
            return response.text;
        }

        // Fallback: aggregate text parts from first candidate payload.
        const parts = response?.candidates?.[0]?.content?.parts;
        if (Array.isArray(parts)) {
            return parts
                .map((part: any) => (typeof part?.text === "string" ? part.text : ""))
                .filter(Boolean)
                .join("");
        }

        return "";
    }

    /**
     * Converts supported input source variants into Gemini inline audio payload.
     *
     * @param source Input audio source
     * @param mimeHint Optional mime override
     * @returns Base64 audio payload plus mime type
     * @throws {Error} If input source is unsupported
     * @private
     */
    private async resolveAudioPayload(
        source: ClientAudioTranscriptionRequest["file"],
        mimeHint?: string
    ): Promise<{ base64: string; mimeType: string }> {
        if (this.isBlobLike(source)) {
            // Browser/native Blob flow.
            const mimeType = mimeHint || (source as any).type || "audio/mpeg";
            const bytes = Buffer.from(await (source as any).arrayBuffer());
            return { base64: bytes.toString("base64"), mimeType };
        }

        if (Buffer.isBuffer(source)) {
            // Node Buffer flow.
            return { base64: source.toString("base64"), mimeType: mimeHint ?? "audio/mpeg" };
        }

        if (source instanceof Uint8Array) {
            // Typed-array flow (common for SDK wrappers and fetch byte payloads).
            return { base64: Buffer.from(source).toString("base64"), mimeType: mimeHint ?? "audio/mpeg" };
        }

        if (source instanceof ArrayBuffer) {
            // Raw ArrayBuffer flow.
            return { base64: Buffer.from(source).toString("base64"), mimeType: mimeHint ?? "audio/mpeg" };
        }

        if (typeof source === "string") {
            if (source.startsWith("data:")) {
                // Data URL flow: decode payload and keep embedded mime when present.
                return this.parseDataUrl(source);
            }

            if (existsSync(source)) {
                // Local file flow: read bytes and infer mime from extension when needed.
                const bytes = await readFile(source);
                const mimeType = mimeHint ?? this.inferMimeFromPath(source);
                return { base64: bytes.toString("base64"), mimeType };
            }

            throw new Error("String audio input must be a data URL or local file path");
        }

        if (this.isReadableStreamLike(source)) {
            // Stream flow: consume stream once and inline full payload.
            const bytes = await this.readNodeStreamToBuffer(source as NodeJS.ReadableStream);
            return { base64: bytes.toString("base64"), mimeType: mimeHint ?? "audio/mpeg" };
        }

        throw new Error("Unsupported audio input source for Gemini transcription");
    }

    /**
     * Builds provider prompt to steer transcription output shape and style.
     *
     * @param language Optional language hint
     * @param prompt Optional caller prompt override
     * @param responseFormat Desired response format hint
     * @returns Consolidated instruction text
     * @private
     */
    private buildTranscriptionInstruction(
        language?: string,
        prompt?: string,
        responseFormat?: ClientAudioTranscriptionRequest["responseFormat"]
    ): string {
        // Keep language/prompt hints additive so they guide without overriding caller intent.
        const languageHint = language?.trim() ? `The spoken language is likely ${language.trim()}.` : "";
        const promptHint = prompt?.trim() ? `Additional guidance: ${prompt.trim()}` : "";

        const formatHint = (() => {
            switch (responseFormat) {
                case "srt":
                    return "Return SRT subtitle format.";
                case "vtt":
                    return "Return WebVTT subtitle format.";
                case "verbose_json":
                case "diarized_json":
                    return "Return a detailed JSON transcription with timestamps and segments.";
                case "text":
                    return "Return plain text only.";
                case "json":
                default:
                    return "Return the transcript text only.";
            }
        })();

        return [
            // Start with an invariant instruction to anchor behavior across models.
            "Transcribe the provided audio accurately.",
            languageHint,
            formatHint,
            promptHint
        ]
            .filter(Boolean)
            .join(" ");
    }

    /**
     * Runtime check for Blob/File-like input values.
     *
     * @param value Candidate input
     * @returns True when value exposes `arrayBuffer`
     * @private
     */
    private isBlobLike(value: unknown): boolean {
        return !!value && typeof value === "object" && typeof (value as any).arrayBuffer === "function";
    }

    /**
     * Runtime check for Node readable stream inputs.
     *
     * @param value Candidate input
     * @returns True when value looks like a readable stream
     * @private
     */
    private isReadableStreamLike(value: unknown): value is NodeJS.ReadableStream {
        return (
            !!value &&
            typeof value === "object" &&
            typeof (value as any).pipe === "function" &&
            typeof (value as any).on === "function"
        );
    }

    /**
     * Reads a Node readable stream into a single in-memory Buffer.
     *
     * @param stream Readable stream source
     * @returns Full stream bytes
     * @private
     */
    private async readNodeStreamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
        const chunks: Buffer[] = [];
        return await new Promise<Buffer>((resolve, reject) => {
            // Preserve binary integrity by converting each incoming chunk to Buffer.
            stream.on("data", (chunk: Buffer | Uint8Array | string) => {
                chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk));
            });
            stream.on("end", () => resolve(Buffer.concat(chunks)));
            stream.on("error", reject);
        });
    }

    /**
     * Parses a data URL to base64 payload and mime type.
     *
     * @param dataUrl Data URL input
     * @returns Parsed base64 + mime data
     * @throws {Error} If data URL is malformed
     * @private
     */
    private parseDataUrl(dataUrl: string): { base64: string; mimeType: string } {
        const commaIndex = dataUrl.indexOf(",");
        if (commaIndex < 0) {
            throw new Error("Invalid data URL");
        }
        const header = dataUrl.slice(0, commaIndex);
        const payload = dataUrl.slice(commaIndex + 1);
        const mimeMatch = /^data:([^;]+)(;base64)?$/i.exec(header);
        const mimeType = mimeMatch?.[1] ?? "application/octet-stream";
        const isBase64 = /;base64$/i.test(header);
        return {
            // Non-base64 data URLs are urlencoded text payloads, so we normalize them to base64.
            base64: isBase64 ? payload : Buffer.from(decodeURIComponent(payload), "utf8").toString("base64"),
            mimeType
        };
    }

    /**
     * Infers audio mime type from local file extension.
     *
     * @param filePath Local file path
     * @returns Inferred mime type
     * @private
     */
    private inferMimeFromPath(filePath: string): string {
        const lower = filePath.toLowerCase();
        if (lower.endsWith(".wav")) {
            return "audio/wav";
        }
        if (lower.endsWith(".flac")) {
            return "audio/flac";
        }
        if (lower.endsWith(".m4a")) {
            return "audio/mp4";
        }
        if (lower.endsWith(".ogg") || lower.endsWith(".oga")) {
            return "audio/ogg";
        }
        if (lower.endsWith(".opus")) {
            return "audio/opus";
        }
        if (lower.endsWith(".aac")) {
            return "audio/aac";
        }
        if (lower.endsWith(".webm")) {
            return "audio/webm";
        }
        return "audio/mpeg";
    }
}
