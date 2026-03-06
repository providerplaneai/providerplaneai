import {
    AIProvider,
    AIRequest,
    AudioCapabilityError,
    ClientAudioTranscriptionRequest,
    extractAudioMimeInfo,
    NormalizedAudio,
    resolveAudioInputMimeType
} from "#root/index.js";

export async function extractGeminiAudioFromStreamResult(stream: any)
    : Promise<{ data: string; mimeType?: string; url?: string } | undefined> {

    const possibleResponses = [stream?.response, stream?.finalResponse, stream?.result];

    for (const candidate of possibleResponses) {
        let resolved: any;
        if (candidate && typeof candidate.then === "function") {
            try {
                resolved = await candidate;
            } catch {
                resolved = undefined;
            }
        } else {
            resolved = candidate;
        }

        const audioPart = extractGeminiAudioPart(resolved);
        if (audioPart) {
            return audioPart;
        }
    }
    return undefined;
}

/**
  * Extracts the first inline audio part from a Gemini response chunk.
  * @param response Raw Gemini response/chunk
  * @returns Audio payload + mime type when present
  */
export function extractGeminiAudioPart(response: any): { data: string; mimeType?: string; url?: string } | undefined {
    for (const part of extractGeminiContentParts(response)) {
        const inlineData = part?.inlineData ?? part?.inline_data;
        const data = inlineData?.data;
        if (typeof data === "string" && data.length > 0) {
            const rawUrl =
                part?.fileData?.fileUri ??
                part?.fileData?.uri ??
                part?.file_data?.file_uri ??
                part?.file_data?.uri ??
                part?.url ??
                inlineData?.url;
            const mimeType = inlineData?.mimeType ?? inlineData?.mime_type;
            return {
                data,
                mimeType: typeof mimeType === "string" ? mimeType : undefined,
                url: typeof rawUrl === "string" && /^https?:\/\//i.test(rawUrl) ? rawUrl : undefined
            };
        }
    }
    return undefined;
}

export function extractGeminiContentParts(response: any): any[] {
    const roots = [response, response?.response, response?.data].filter(Boolean);
    const parts: any[] = [];

    for (const root of roots) {
        const candidates = root?.candidates;
        if (!Array.isArray(candidates)) {
            continue;
        }
        for (const candidate of candidates) {
            const candidateParts = candidate?.content?.parts;
            if (Array.isArray(candidateParts)) {
                parts.push(...candidateParts);
            }
        }
    }
    return parts;
}

/**
 * Removes optional `models/` prefix for Gemini SDK model values.
 *
 * @param model Model identifier
 * @returns Model identifier without `models/` prefix
 */
export function stripModelPrefix(model: string): string {
    return model.replace(/^models\//, "");
}

/**
 * Extracts usage metadata from Gemini responses when available.
 *
 * @param response Raw Gemini response/chunk
 * @returns Token usage fields if present
 */
export function extractUsage(response: any): {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
} {
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
 * Builds a Gemini `contents` payload containing prompt + inline audio.
 *
 * @param prompt Instruction text
 * @param audio Normalized inline audio payload
 * @returns Gemini contents array for generateContent/generateContentStream
 */
export function buildAudioContents(prompt: string, audio: { base64: string; mimeType: string }) {
    return [
        {
            role: "user",
            parts: [{ text: prompt }, { inlineData: { mimeType: audio.mimeType, data: audio.base64 } }]
        }
    ];
}

/**
 * Builds normalized metadata payload for AI responses/chunks.
 *
 * @param context Request context
 * @param model Resolved model
 * @param status Execution status
 * @param usage Optional usage fields
 * @param requestIdOverride Optional request id override for streaming paths
 * @returns Metadata object
 */
export function buildMetadata(
    context: AIRequest<unknown>["context"] | undefined,
    model: string | undefined,
    status: "incomplete" | "completed" | "error",
    usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number },
    requestIdOverride?: string,
    extras?: Record<string, unknown>
) {
    return {
        ...(context?.metadata ?? {}),
        provider: AIProvider.Gemini,
        model,
        status,
        requestId: requestIdOverride ?? context?.requestId,
        ...(usage ?? {}),
        ...(extras ?? {})
    };
}

/**
 * Extracts best-effort text from Gemini response shape.
 * @param response Raw Gemini response/chunk
 * @returns Concatenated text content, or empty string when unavailable
 */
export function extractGeminiText(response: any): string {
    if (typeof response?.text === "string") {
        return response.text;
    }
    const parts = response?.candidates?.[0]?.content?.parts;
    if (!Array.isArray(parts)) {
        return "";
    }
    return parts
        .map((p: any) => (typeof p?.text === "string" ? p.text : ""))
        .filter(Boolean)
        .join("");
}

/**
 * Converts supported client audio input sources into inline base64 + mime type.
 *
 * Intentional contract:
 * - String input must be a Data URL.
 * - Local file path reading is NOT done here (caller responsibility).
 *
 * @param input Client audio input source
 * @param explicitMimeType Optional mime type hint
 * @param filename Optional filename hint for extension-based detection
 * @returns Normalized base64 audio payload and mime type
 * @throws Error when input source is unsupported
 */
export async function normalizeAudioInput(
    input: ClientAudioTranscriptionRequest["file"],
    explicitMimeType?: string,
    filename?: string
): Promise<{ base64: string; mimeType: string }> {
    const mimeType = resolveAudioInputMimeType(input, explicitMimeType, filename);

    if (typeof input === "string") {
        if (input.startsWith("data:")) {
            const [header, payload] = input.split(",", 2);
            if (!payload) {
                throw new AudioCapabilityError("AUDIO_INVALID_PAYLOAD", "Invalid audio data URL");
            }
            const headerMime = header.match(/^data:([^;]+);base64$/i)?.[1];
            return {
                base64: payload,
                mimeType: explicitMimeType ?? headerMime ?? mimeType
            };
        }
        throw new AudioCapabilityError(
            "AUDIO_UNSUPPORTED_INPUT",
            "String audio input must be a data URL. Provide bytes/stream/blob for local files."
        );
    }

    if (typeof Buffer !== "undefined" && Buffer.isBuffer(input)) {
        return { base64: input.toString("base64"), mimeType };
    }

    if (input instanceof Uint8Array) {
        return { base64: Buffer.from(input).toString("base64"), mimeType };
    }

    if (input instanceof ArrayBuffer) {
        return { base64: Buffer.from(new Uint8Array(input)).toString("base64"), mimeType };
    }

    if ((input as any)?.arrayBuffer && typeof (input as any).arrayBuffer === "function") {
        // Browser/File-like objects expose bytes via arrayBuffer().
        const arr = await (input as any).arrayBuffer();
        return { base64: Buffer.from(new Uint8Array(arr)).toString("base64"), mimeType };
    }

    if (isReadableStream(input)) {
        // Gemini inlineData requires full base64 payload, so stream input is buffered once here.
        const chunks: Buffer[] = [];
        for await (const chunk of input as any) {
            if (typeof chunk === "string") {
                chunks.push(Buffer.from(chunk));
            } else if (Buffer.isBuffer(chunk)) {
                chunks.push(chunk);
            } else if (chunk instanceof Uint8Array) {
                chunks.push(Buffer.from(chunk));
            }
        }
        return { base64: Buffer.concat(chunks).toString("base64"), mimeType };
    }

    throw new AudioCapabilityError("AUDIO_UNSUPPORTED_INPUT", "Unsupported audio input source");
}

/**
 * Best-effort Node readable stream guard for async iterable streams.
 *
 * @param value Unknown input
 * @returns True when value behaves like a Node readable async iterable stream
 */
export function isReadableStream(value: unknown): value is NodeJS.ReadableStream {
    return !!value && typeof value === "object" && Symbol.asyncIterator in (value as object);
}
