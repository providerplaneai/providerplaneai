import {
    AIProvider,
    AIRequest,
    createAudioArtifact,
    extractAudioMimeInfo,
    NormalizedAudio
} from "#root/index.js";

/**
 * Extracts provider response id from heterogeneous stream event shapes.
 */
export function extractEventResponseId(event: unknown): string | undefined {
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
export function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
    return typeof (value as { [Symbol.asyncIterator]?: unknown } | null)?.[Symbol.asyncIterator] === "function";
}

/**
 * Normalizes transcription delta text across possible OpenAI stream event variants.
 */
export function extractTranscriptionDelta(event: unknown): string {
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
 * Constructs a normalized synthesized speech artifact.
 */
export function createSpeechArtifact(id: string, mimeType: string, base64: string, url?: string): NormalizedAudio {
    const details = extractAudioMimeInfo(mimeType);
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

export function inferDurationSeconds(segments: NormalizedAudio["segments"], words: NormalizedAudio["words"]): number | undefined {
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

export function extractNonDataUrl(response: unknown): string | undefined {
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
        if (typeof candidate === "string" && /^https?:\/\//i.test(candidate) && isLikelyAssetUrl(candidate)) {
            return candidate;
        }
    }
    return undefined;
}

export function isLikelyAssetUrl(url: string): boolean {
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

export function buildMetadata(
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
export function extractSegments(response: unknown): NormalizedAudio["segments"] {
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
export function extractWords(response: unknown): NormalizedAudio["words"] {
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
