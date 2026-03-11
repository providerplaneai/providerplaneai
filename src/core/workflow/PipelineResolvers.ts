/**
 * @module core/workflow/PipelineResolvers.ts
 * @description Helper resolvers used by the high-level Pipeline API.
 */
import { PipelineError, type ClientReferenceImage } from "#root/index.js";

/**
 * Extracts best-effort text from arbitrary workflow step output shapes.
 *
 * @public
 * @param {unknown} value Step output value to inspect recursively.
 * @returns {string} Normalized text assembled from discovered content fragments.
 * @remarks
 * This resolver intentionally prioritizes robustness over strict typing because
 * provider payloads vary significantly across capabilities and versions.
 * The implementation:
 * 1. Traverses arrays/objects recursively with cycle protection.
 * 2. Reads known text-bearing keys (`text`, `description`, `summary`, etc.).
 * 3. De-duplicates repeated fragments while preserving first-seen order.
 */
export function extractPipelineText(value: unknown): string {
    const collected: string[] = [];
    const seen = new WeakSet<object>();
    const textKeyPattern = /(text|content|description|summary|transcript|translation|message|answer|caption|delta|reason)/i;

    const pushText = (candidate: unknown) => {
        if (typeof candidate !== "string") {
            return;
        }
        const trimmed = candidate.trim();
        if (!trimmed) {
            return;
        }
        if (!collected.includes(trimmed)) {
            collected.push(trimmed);
        }
    };

    const collectFromContentParts = (parts: unknown[]) => {
        for (const part of parts) {
            if (typeof part === "string") {
                pushText(part);
                continue;
            }
            if (!part || typeof part !== "object") {
                continue;
            }
            const typedPart = part as Record<string, unknown>;
            if (typeof typedPart.text === "string") {
                pushText(typedPart.text);
            }
            if (typeof typedPart.delta === "string") {
                pushText(typedPart.delta);
            }
            if (typedPart.text && typeof typedPart.text === "object") {
                pushText((typedPart.text as Record<string, unknown>).value);
            }
        }
    };

    const collect = (node: unknown, parentKey = "", depth = 0) => {
        // Guard recursion depth and nullish values to avoid runaway traversal.
        if (depth > 8 || node === null || node === undefined) {
            return;
        }

        if (typeof node === "string") {
            if (!parentKey || textKeyPattern.test(parentKey)) {
                pushText(node);
            }
            return;
        }

        if (Array.isArray(node)) {
            for (const item of node) {
                collect(item, parentKey, depth + 1);
            }
            return;
        }

        if (typeof node !== "object") {
            return;
        }

        const obj = node as Record<string, unknown>;
        // Prevent infinite recursion for cyclic payload graphs.
        if (seen.has(obj)) {
            return;
        }
        seen.add(obj);

        if (Array.isArray(obj.content)) {
            collectFromContentParts(obj.content);
        }
        if (Array.isArray(obj.parts)) {
            collectFromContentParts(obj.parts);
        }

        const directTextKeys = [
            "outputText",
            "finalText",
            "answerText",
            "summaryText",
            "description",
            "transcript",
            "translation",
            "message",
            "delta",
            "text"
        ] as const;
        for (const key of directTextKeys) {
            pushText(obj[key]);
        }

        const knownContainerKeys = [
            "output",
            "delta",
            "rawResponse",
            "response",
            "result",
            "value",
            "data",
            "candidates",
            "parts",
            "content"
        ] as const;
        for (const key of knownContainerKeys) {
            if (obj[key] !== undefined) {
                collect(obj[key], key, depth + 1);
            }
        }

        for (const [key, child] of Object.entries(obj)) {
            // Avoid duplicate traversal for already-handled container keys.
            if (knownContainerKeys.includes(key as (typeof knownContainerKeys)[number])) {
                continue;
            }
            if (typeof child === "string" && textKeyPattern.test(key)) {
                pushText(child);
                continue;
            }
            if (child && (typeof child === "object" || Array.isArray(child))) {
                collect(child, key, depth + 1);
            }
        }
    };

    collect(value);
    return collected.join("\n").trim();
}

/**
 * Convert a generated image artifact into a `ClientReferenceImage`.
 *
 * @public
 * @param {unknown} value Step output value (typically image generation output array).
 * @returns {ClientReferenceImage} Canonical image reference used by downstream capability calls.
 * @throws {PipelineError} When no image artifact exists or artifact is missing both `base64` and `url`.
 */
export function extractPipelineImageReference(value: unknown): ClientReferenceImage {
    const arr = Array.isArray(value) ? value : [value];
    const image = arr[0] as any;
    if (!image || typeof image !== "object") {
        throw new PipelineError("Pipeline: no image artifact found in source step output");
    }

    const base64 = typeof image.base64 === "string" ? image.base64.trim() : "";
    if (base64) {
        return {
            id: String(image.id ?? "generated-image"),
            sourceType: "base64",
            base64,
            mimeType: String(image.mimeType ?? "image/png")
        };
    }

    if (typeof image.url === "string" && image.url.trim().length > 0) {
        return {
            id: String(image.id ?? "generated-image"),
            sourceType: "url",
            url: image.url
        };
    }

    throw new PipelineError("Pipeline: image source is missing both base64 and url");
}

/**
 * Extract an audio artifact from a step output.
 *
 * @public
 * @param {unknown} value Step output value.
 * @returns {{ id?: string; mimeType?: string; base64?: string; url?: string }} First audio-like artifact.
 * @throws {PipelineError} When no object-like artifact is present.
 */
export function extractPipelineAudioArtifact(value: unknown): {
    id?: string;
    mimeType?: string;
    base64?: string;
    url?: string;
} {
    const arr = Array.isArray(value) ? value : [value];
    const audio = arr[0] as any;
    if (!audio || typeof audio !== "object") {
        throw new PipelineError("Pipeline: no audio artifact found in source step output");
    }
    return audio;
}

/**
 * Convert an audio artifact into an audio input source accepted by transcription/translation.
 *
 * @public
 * @param {{ base64?: string; url?: string; mimeType?: string }} audio Audio artifact candidate.
 * @returns {string} Data URL (when base64 exists) or remote URL.
 * @throws {PipelineError} When the artifact has neither `base64` nor `url`.
 */
export function toPipelineAudioInput(audio: { base64?: string; url?: string; mimeType?: string }): string {
    const base64 = typeof audio.base64 === "string" ? audio.base64.trim() : "";
    if (base64) {
        const mimeType = String(audio.mimeType ?? "audio/mpeg");
        return `data:${mimeType};base64,${base64}`;
    }
    if (typeof audio.url === "string" && audio.url.trim().length > 0) {
        return audio.url;
    }
    throw new PipelineError("Pipeline: audio source is missing both base64 and url");
}

/**
 * Resolve `{{stepId}}` placeholders in a template using extracted text from step outputs.
 *
 * @public
 * @param {string} template Input template with `{{stepId}}` placeholders.
 * @param {Record<string, unknown>} values Workflow state values keyed by step id.
 * @returns {string} Template with placeholders replaced by normalized step text.
 * @remarks
 * Missing tokens resolve to empty strings after `extractPipelineText` evaluation.
 */
export function resolvePipelineTemplate(template: string, values: Record<string, unknown>): string {
    return template.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_match, tokenRaw) => {
        const token = String(tokenRaw).trim();
        if (!token) {
            return "";
        }
        return extractPipelineText(values[token]);
    });
}
