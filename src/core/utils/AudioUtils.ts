import { AudioCapabilityError, NormalizedAudio } from "#root/index.js";

export type AudioArtifactParams = {
    id?: string;
    kind?: NormalizedAudio["kind"];
    mimeType: string;
    url?: string;
    base64?: string;
    durationSeconds?: number;
    language?: string;
    transcript?: string;
    segments?: NormalizedAudio["segments"];
    words?: NormalizedAudio["words"];
    sampleRateHz?: number;
    channels?: number;
    bitrate?: number;
    raw?: unknown;
};

export type AudioResponseIdKey = "id" | "responseId";

/**
 * Builds a normalized audio artifact with optional fields.
 * @param params Audio artifact parameters
 * @returns NormalizedAudio object with generated ID and provided fields
 */
export function createAudioArtifact(params: AudioArtifactParams): NormalizedAudio {
    return {
        id: params.id ?? crypto.randomUUID(),
        ...(params.kind ? { kind: params.kind } : {}),
        mimeType: params.mimeType,
        ...(params.url ? { url: params.url } : {}),
        ...(params.base64 ? { base64: params.base64 } : {}),
        ...(params.durationSeconds !== undefined ? { durationSeconds: params.durationSeconds } : {}),
        ...(params.language ? { language: params.language } : {}),
        ...(params.transcript ? { transcript: params.transcript } : {}),
        ...(params.segments ? { segments: params.segments } : {}),
        ...(params.words ? { words: params.words } : {}),
        ...(params.sampleRateHz !== undefined ? { sampleRateHz: params.sampleRateHz } : {}),
        ...(params.channels !== undefined ? { channels: params.channels } : {}),
        ...(params.bitrate !== undefined ? { bitrate: params.bitrate } : {}),
        ...(params.raw !== undefined ? { raw: params.raw } : {})
    };
}

/**
 * Builds a normalized transcription artifact with inferred audio detail fields from MIME metadata.
 * @param mimeType Input/output audio MIME type
 * @param transcript Transcript text
 * @param language Optional language hint
 * @param id Optional deterministic artifact id
 * @returns Normalized transcription artifact
 */
export function createTranscriptionAudioArtifact(
    mimeType: string,
    transcript: string,
    language?: string,
    id?: string
): NormalizedAudio {
    const details = extractAudioMimeInfo(mimeType);
    return createAudioArtifact({
        id: id ?? crypto.randomUUID(),
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
 * Parses optional audio metadata parameters from a MIME type string.
 *
 * Supported parameter aliases:
 * - sample rate: `rate` or `samplerate`
 * - channel count: `channels` or `channelcount`
 * - bitrate: `bitrate`
 *
 * Examples:
 * - `audio/L16;rate=24000;channels=1`
 * - `audio/wav;samplerate=48000;channelcount=2`
 *
 * @param mimeType MIME type string with optional parameters
 * @returns Parsed numeric audio fields when present
 */
export function extractAudioMimeInfo(mimeType: string | undefined): {
    sampleRateHz?: number;
    channels?: number;
    bitrate?: number;
} {
    if (!mimeType) {
        return {};
    }

    const lower = mimeType.toLowerCase();
    // Split MIME parameters after the first `;` and parse key=value pairs.
    const paramsRaw = lower.includes(";") ? lower.split(";").slice(1) : [];
    const params = new Map<string, string>();
    for (const part of paramsRaw) {
        const [k, v] = part.split("=", 2);
        if (!k || !v) {
            continue;
        }
        params.set(k.trim(), v.trim());
    }

    const rate = params.get("rate") ?? params.get("samplerate");
    const channels = params.get("channels") ?? params.get("channelcount");
    const bitrate = params.get("bitrate");

    return {
        sampleRateHz: rate ? Number.parseInt(rate, 10) || undefined : undefined,
        channels: channels ? Number.parseInt(channels, 10) || undefined : undefined,
        bitrate: bitrate ? Number.parseInt(bitrate, 10) || undefined : undefined
    };
}

/**
 * Resolves an input audio MIME type from explicit hints or filename extension.
 *
 * Resolution order:
 * 1. `explicitMimeType`
 * 2. `file.type` (for Blob/File-like inputs)
 * 3. `filename` / `file` string / `file.name` extension
 * 4. fallback to `audio/mpeg`
 *
 * @param file Input source
 * @param explicitMimeType Explicit MIME override
 * @param filename Optional filename hint
 * @returns Resolved MIME type
 */
export function resolveAudioInputMimeType(file: unknown, explicitMimeType?: string, filename?: string): string {
    if (explicitMimeType) {
        return explicitMimeType;
    }

    const mime = (file as any)?.type;
    if (typeof mime === "string" && mime.length > 0) {
        return mime;
    }

    const name = filename ?? (typeof file === "string" ? file : undefined) ?? ((file as any)?.name as string | undefined) ?? "";
    const lower = name.toLowerCase();
    if (lower.endsWith(".wav")) {
        return "audio/wav";
    }
    if (lower.endsWith(".flac")) {
        return "audio/flac";
    }
    if (lower.endsWith(".aac")) {
        return "audio/aac";
    }
    if (lower.endsWith(".opus")) {
        return "audio/opus";
    }
    if (lower.endsWith(".ogg")) {
        return "audio/ogg";
    }
    if (lower.endsWith(".pcm")) {
        return "audio/pcm";
    }
    return "audio/mpeg";
}

/**
 * Resolves an output MIME type for synthesized/returned audio.
 *
 * Resolution order:
 * 1. `contentType` header (without parameters)
 * 2. requested `format`
 * 3. `defaultFormat`
 *
 * @param format Requested output format (e.g., `mp3`, `wav`)
 * @param contentType HTTP `Content-Type` header value
 * @param defaultFormat Fallback format when `format` is unset
 * @returns Resolved MIME type
 */
export function resolveAudioOutputMimeType(
    format: string | undefined,
    contentType: string | null,
    defaultFormat = "mp3"
): string {
    const fromHeader = contentType?.split(";")[0]?.trim();
    if (fromHeader) {
        return fromHeader;
    }

    switch ((format ?? defaultFormat).toLowerCase()) {
        case "wav":
            return "audio/wav";
        case "flac":
            return "audio/flac";
        case "aac":
            return "audio/aac";
        case "opus":
            return "audio/opus";
        case "pcm":
            return "audio/pcm";
        case "mp3":
        default:
            return "audio/mpeg";
    }
}

/**
 * Enforces a maximum audio payload size.
 *
 * A `maxBytes` value of `undefined`, non-finite, or `<= 0` disables the limit.
 *
 * @param bytes Actual byte length
 * @param maxBytes Configured maximum byte length
 * @param source Logical source string for diagnostics
 * @throws AudioCapabilityError with code `AUDIO_OUTPUT_TOO_LARGE` when exceeded
 */
export function assertAudioBytesWithinLimit(bytes: number, maxBytes: number | undefined, source: string): void {
    if (!Number.isFinite(maxBytes) || (maxBytes ?? 0) <= 0) {
        return;
    }
    if (bytes <= (maxBytes as number)) {
        return;
    }

    throw new AudioCapabilityError(
        "AUDIO_OUTPUT_TOO_LARGE",
        `Audio output exceeded configured max bytes (${bytes} > ${maxBytes})`,
        { source, bytes, maxBytes }
    );
}

/**
 * Decodes and validates base64-encoded audio payloads.
 *
 * Validation performed:
 * - must be a non-empty string
 * - must decode without throwing
 * - decoded byte length must be > 0
 *
 * @param base64 Base64-encoded audio string
 * @param source Logical source string for diagnostics
 * @returns Decoded audio bytes
 * @throws AudioCapabilityError with `AUDIO_EMPTY_RESPONSE` or `AUDIO_INVALID_PAYLOAD`
 */
export function decodeBase64Audio(base64: string, source: string): Buffer {
    if (typeof base64 !== "string" || base64.length === 0) {
        throw new AudioCapabilityError("AUDIO_EMPTY_RESPONSE", "Audio payload was empty", { source });
    }

    const compact = base64.trim().replace(/\s+/g, "");
    if (compact.length === 0) {
        throw new AudioCapabilityError("AUDIO_EMPTY_RESPONSE", "Audio payload was empty", { source });
    }

    // Strict base64 validation: only RFC 4648 alphabet + trailing padding and 4-char alignment.
    if (compact.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(compact)) {
        throw new AudioCapabilityError("AUDIO_INVALID_PAYLOAD", "Audio payload was not valid base64", { source });
    }
    const firstPadding = compact.indexOf("=");
    if (firstPadding !== -1 && /[^=]/.test(compact.slice(firstPadding))) {
        throw new AudioCapabilityError("AUDIO_INVALID_PAYLOAD", "Audio payload was not valid base64", { source });
    }

    let bytes: Buffer;
    try {
        bytes = Buffer.from(compact, "base64");
    } catch {
        throw new AudioCapabilityError("AUDIO_INVALID_PAYLOAD", "Audio payload was not valid base64", { source });
    }

    if (bytes.length === 0) {
        throw new AudioCapabilityError("AUDIO_EMPTY_RESPONSE", "Decoded audio payload was empty", { source });
    }

    return bytes;
}

/**
 * Extracts a response id from an arbitrary provider payload using ordered key preference.
 * @param response Arbitrary response object
 * @param keys Ordered candidate keys to probe
 * @returns First string id found, otherwise undefined
 */
export function extractResponseIdByKeys(
    response: unknown,
    keys: readonly AudioResponseIdKey[]
): string | undefined {
    if (!response || typeof response !== "object") {
        return undefined;
    }
    const direct = response as Record<string, unknown>;
    for (const key of keys) {
        if (typeof direct[key] === "string") {
            return direct[key] as string;
        }
    }
    return undefined;
}

/**
 * Extracts normalized audio error codes from known error shapes.
 * @param err Unknown thrown value
 * @returns Audio error code when present
 */
export function extractAudioErrorCode(err: unknown): string | undefined {
    if (err instanceof AudioCapabilityError) {
        return err.code;
    }
    if (!(err instanceof Error) || typeof err.message !== "string") {
        return undefined;
    }
    const match = err.message.match(/\[(AUDIO_[A-Z_]+)\]/);
    return match?.[1];
}
