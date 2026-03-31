/**
 * @module providers/openai/capabilities/OpenAIAudioTranslationCapabilityImpl.ts
 * @description Provider implementations and capability adapters.
 */
import OpenAI from "openai";
import { toFile } from "openai/uploads";
import { readFile, access } from "node:fs/promises";
import {
    AIProvider,
    AIRequest,
    AIResponse,
    AudioTranslationCapability,
    BaseProvider,
    CapabilityKeys,
    ClientAudioTranslationRequest,
    MultiModalExecutionContext,
    NormalizedChatMessage,
    parseDataUriToBuffer
} from "#root/index.js";

const DEFAULT_OPENAI_AUDIO_TRANSLATION_MODEL = "whisper-1";
const ENGLISH_TARGET_ALIASES = new Set(["en", "eng", "english", "en-us", "en-gb"]);

/**
 * OpenAI audio translation capability implementation.
 *
 * Uses the dedicated Audio Translations endpoint (`/v1/audio/translations`).
 * OpenAI translation output is English.
 *
 */
/**
 * @public
 * @description Provider capability implementation for OpenAIAudioTranslationCapabilityImpl.
 */
export class OpenAIAudioTranslationCapabilityImpl implements AudioTranslationCapability<ClientAudioTranslationRequest> {
    /**
     * Creates a new OpenAI audio translation capability delegate.
     *
     * @param provider Parent provider for lifecycle/config access
     * @param client Initialized OpenAI SDK client
     */
    constructor(
        private readonly provider: BaseProvider,
        private readonly client: OpenAI
    ) {}

    /**
     * Translates spoken audio into English text.
     *
     * @param request Unified AI request containing translation input/options/context
     * @param _ctx Optional multimodal execution context (unused by this capability)
     * @param signal Optional abort signal
     * @returns Provider-normalized translated chat message artifacts
     * @throws {Error} If input file is missing, request is aborted, or target language is unsupported
     */
    async translateAudio(
        request: AIRequest<ClientAudioTranslationRequest>,
        _ctx: MultiModalExecutionContext,
        signal?: AbortSignal
    ): Promise<AIResponse<NormalizedChatMessage[]>> {
        this.provider.ensureInitialized();

        if (signal?.aborted) {
            throw new Error("Audio translation request aborted before execution");
        }

        const { input, options, context } = request;
        if (!input?.file) {
            throw new Error("Audio translation requires a non-empty 'file' input");
        }

        // OpenAI audio translation endpoint translates to English.
        if (input.targetLanguage && !this.isEnglishTarget(input.targetLanguage)) {
            throw new Error("OpenAI audio translation supports English output only");
        }

        const merged = this.provider.getMergedOptions(CapabilityKeys.AudioTranslationCapabilityKey, options);
        const model = merged.model ?? DEFAULT_OPENAI_AUDIO_TRANSLATION_MODEL;

        // Convert caller-provided source variants (buffer/blob/path/data URL/stream) into OpenAI upload format.
        const uploadFile = await this.toUploadableAudioFile(input.file, input.filename, input.mimeType);
        const response = await this.client.audio.translations.create(
            {
                file: uploadFile as any,
                model: model as any,
                ...(input.prompt !== undefined ? { prompt: input.prompt } : {}),
                ...(input.responseFormat !== undefined ? { response_format: input.responseFormat as any } : {}),
                ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
                ...(merged.modelParams ?? {}),
                ...(merged.providerParams ?? {})
            },
            { signal }
        );

        const responseId = (response as any)?.id ?? context?.requestId ?? crypto.randomUUID();
        const text = this.extractTranslationText(response);

        const message: NormalizedChatMessage = {
            id: responseId,
            role: "assistant",
            content: text ? [{ type: "text", text }] : [],
            metadata: {
                ...(context?.metadata ?? {}),
                provider: AIProvider.OpenAI,
                model,
                status: "completed",
                requestId: context?.requestId
            }
        };

        return {
            output: [message],
            multimodalArtifacts: { chat: [message] },
            id: responseId,
            rawResponse: response,
            metadata: {
                ...(context?.metadata ?? {}),
                provider: AIProvider.OpenAI,
                model,
                status: "completed",
                requestId: context?.requestId
            }
        };
    }

    /**
     * Checks whether a target language hint maps to English.
     *
     * @param value User-provided target language hint
     * @returns `true` when hint is an English variant
     */
    private isEnglishTarget(value: string): boolean {
        return ENGLISH_TARGET_ALIASES.has(value.trim().toLowerCase());
    }

    /**
     * Extracts translated text from OpenAI translation response variants.
     *
     * @param response Raw response payload from OpenAI SDK
     * @returns Extracted translated text (empty string if unavailable)
     */
    private extractTranslationText(response: unknown): string {
        if (typeof response === "string") {
            return response;
        }
        const asAny = response as any;
        if (typeof asAny?.text === "string") {
            return asAny.text;
        }
        return "";
    }

    /**
     * Converts supported audio input source variants to an OpenAI uploadable file object.
     *
     * Supported inputs:
     * - File/Blob
     * - Buffer/Uint8Array/ArrayBuffer
     * - String data URL
     * - String local file path
     * - Stream-like values supported by `toFile`
     *
     * @param source Input audio source
     * @param filenameHint Optional filename hint
     * @param mimeTypeHint Optional mime type hint
     * @returns Uploadable file object for OpenAI SDK
     * @throws {Error} If a string input is neither a data URL nor local file path
     */
    private async toUploadableAudioFile(
        source: ClientAudioTranslationRequest["file"],
        filenameHint?: string,
        mimeTypeHint?: string
    ) {
        if (this.isBlobLike(source)) {
            const fileName = filenameHint ?? "audio-input";
            return await toFile(source as any, fileName, mimeTypeHint ? { type: mimeTypeHint } : undefined);
        }

        if (Buffer.isBuffer(source)) {
            const fileName = filenameHint ?? "audio-input";
            return await toFile(source, fileName, mimeTypeHint ? { type: mimeTypeHint } : undefined);
        }

        if (source instanceof Uint8Array) {
            const fileName = filenameHint ?? "audio-input";
            return await toFile(Buffer.from(source), fileName, mimeTypeHint ? { type: mimeTypeHint } : undefined);
        }

        if (source instanceof ArrayBuffer) {
            const fileName = filenameHint ?? "audio-input";
            return await toFile(Buffer.from(source), fileName, mimeTypeHint ? { type: mimeTypeHint } : undefined);
        }

        if (typeof source === "string") {
            if (source.startsWith("data:")) {
                // Data URL flow: decode payload bytes and prefer caller mime hint when present.
                const parsed = parseDataUriToBuffer(source);
                const fileName = filenameHint ?? "audio-input";
                return await toFile(parsed.bytes, fileName, { type: mimeTypeHint ?? parsed.mimeType });
            }

            if (await this.pathExists(source)) {
                // Local file flow: read bytes from disk and preserve basename as default filename.
                const bytes = await readFile(source);
                const fileName = filenameHint ?? this.fileNameFromPath(source);
                return await toFile(bytes, fileName, mimeTypeHint ? { type: mimeTypeHint } : undefined);
            }

            if (source.startsWith("http://") || source.startsWith("https://")) {
                throw new Error("String audio input must be a data URL or local file path");
            }

            throw new Error("String audio input must be a data URL or local file path");
        }

        // Includes Node readable streams and any other SDK-supported uploadable values.
        const fileName = filenameHint ?? "audio-input";
        return await toFile(source as any, fileName, mimeTypeHint ? { type: mimeTypeHint } : undefined);
    }

    /**
     * Lightweight runtime check for File/Blob-like objects.
     *
     * @param value Candidate input value
     * @returns `true` when value exposes blob-like shape used by SDK
     */
    private isBlobLike(value: unknown): boolean {
        if (!value || typeof value !== "object") {
            return false;
        }
        return typeof (value as any).arrayBuffer === "function" && typeof (value as any).type === "string";
    }

    /**
     * Extracts a filename from a local path fallback.
     *
     * @param filePath Local file path
     * @returns Basename or default fallback name
     */
    private fileNameFromPath(filePath: string): string {
        const normalized = filePath.replace(/\\/g, "/");
        const name = normalized.split("/").pop();
        return name && name.length > 0 ? name : "audio-input";
    }

    /**
     * Async existence check that avoids blocking the event loop.
     *
     * @param filePath Path to test
     * @returns `true` when path is accessible
     */
    private async pathExists(filePath: string): Promise<boolean> {
        try {
            await access(filePath);
            return true;
        } catch {
            return false;
        }
    }
}
