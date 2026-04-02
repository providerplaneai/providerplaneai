/**
 * @module core/utils/OCRTextUtils.ts
 * @description Shared OCR markdown/text normalization helpers.
 */

/**
 * Converts provider OCR text-like values into a normalized string.
 *
 * Arrays are flattened line-by-line, primitive scalars are stringified, and structured values
 * fall back to JSON so adapters can preserve useful provider output without losing information.
 *
 * @param {unknown} value - Provider OCR value to normalize.
 * @returns {string | undefined} A normalized string when the value contains useful text.
 */
export function normalizeOCRTextValue(value: unknown): string | undefined {
    if (typeof value === "string") {
        const trimmed = value.trim();
        return trimmed.length > 0 ? trimmed : undefined;
    }
    if (typeof value === "number" || typeof value === "boolean") {
        return String(value);
    }
    if (Array.isArray(value)) {
        const parts = value.map((item) => normalizeOCRTextValue(item)).filter((item): item is string => Boolean(item));
        return parts.length > 0 ? parts.join("\n") : undefined;
    }
    if (value && typeof value === "object") {
        try {
            const serialized = JSON.stringify(value);
            return serialized && serialized !== "{}" && serialized !== "[]" ? serialized : undefined;
        } catch {
            return undefined;
        }
    }
    return undefined;
}

/**
 * Removes an outer fenced-code wrapper from a markdown snippet.
 *
 * Providers frequently wrap JSON annotations or OCR side-channel output in fenced blocks; this
 * helper strips only the outer fence so downstream parsing can operate on the actual payload.
 *
 * @param {string} value - Markdown text that may contain a single fenced block.
 * @returns {string} The unfenced payload text.
 */
export function stripMarkdownCodeFence(value: string): string {
    const trimmed = value.trim();
    const match = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
    return (
        match?.[1]?.trim() ??
        trimmed
            .replace(/^```(?:json)?\s*/i, "")
            .replace(/\s*```$/i, "")
            .trim()
    );
}

/**
 * Normalizes OCR annotation text while suppressing prompt-echo responses.
 *
 * Some providers return the original annotation prompt verbatim instead of the parsed annotation
 * payload. When that happens and structured annotation data is available, the structured payload is
 * serialized instead so the artifact still carries useful content.
 *
 * @param {string | undefined} text - Provider annotation text.
 * @param {Record<string, unknown> | unknown[] | undefined} data - Structured annotation payload when present.
 * @param {string | undefined} annotationPrompt - Prompt used to request annotation output.
 * @returns {string | undefined} The normalized annotation text payload.
 */
export function normalizeOCRAnnotationText(
    text: string | undefined,
    data: Record<string, unknown> | unknown[] | undefined,
    annotationPrompt: string | undefined
): string | undefined {
    const normalizedText = normalizeOCRTextValue(text);
    if (!normalizedText) {
        return undefined;
    }

    const normalizedPrompt = annotationPrompt?.trim();
    if (normalizedPrompt && normalizedText === normalizedPrompt) {
        return data ? JSON.stringify(data) : undefined;
    }

    return normalizedText;
}

/**
 * Removes trailing empty markdown table rows from OCR markdown output.
 *
 * OCR providers often emit dangling `| |` rows after otherwise valid tables. Trimming them keeps
 * downstream readable-text extraction and markdown rendering cleaner without altering non-empty
 * content.
 *
 * @param {string | null | undefined} markdown - OCR markdown to normalize.
 * @returns {string} Markdown with empty trailing table rows removed.
 */
export function normalizeOCRMarkdownTableOutput(markdown: string | null | undefined): string {
    if (typeof markdown !== "string" || markdown.trim().length === 0) {
        return "";
    }

    const lines = markdown.split("\n");
    while (lines.length > 0 && isEmptyMarkdownTableRow(lines[lines.length - 1])) {
        lines.pop();
    }

    return lines.join("\n").trim();
}

/**
 * Converts OCR markdown into readable plain text while preserving table cell content and links.
 *
 * @param {string} markdown - OCR markdown to normalize into plain text.
 * @returns {string} Plain-text content derived from the markdown structure.
 */
export function extractReadableTextFromOCRMarkdown(markdown: string): string {
    return markdown
        .split("\n")
        .map((line) => toReadableMarkdownLine(line))
        .filter((line) => line.length > 0)
        .join("\n")
        .trim();
}

/**
 * Collects hyperlinks from OCR markdown and provider-supplied hyperlink arrays.
 *
 * Links are normalized, deduplicated, and returned in discovery order so OCR adapters can preserve
 * useful references without duplicating equivalent URLs.
 *
 * @param {string} markdown - OCR markdown that may contain explicit or bare links.
 * @param {Array<string | undefined | null> | undefined} providerHyperlinks - Provider-native hyperlink values, if any.
 * @returns {string[] | undefined} Normalized hyperlinks when any were found.
 */
export function resolveOCRMarkdownHyperlinks(
    markdown: string,
    providerHyperlinks?: Array<string | undefined | null>
): string[] | undefined {
    const links = new Set<string>();
    for (const value of providerHyperlinks ?? []) {
        const normalized = normalizeHyperlinkValue(value ?? undefined);
        if (normalized) {
            links.add(normalized);
        }
    }

    if (markdown) {
        const markdownLinkRegex = /\[[^\]]+]\((https?:\/\/[^)\s]+)\)/g;
        for (const match of markdown.matchAll(markdownLinkRegex)) {
            const normalized = normalizeHyperlinkValue(match[1]);
            if (normalized) {
                links.add(normalized);
            }
        }

        const autoLinkRegex = /<(https?:\/\/[^>\s]+)>/g;
        for (const match of markdown.matchAll(autoLinkRegex)) {
            const normalized = normalizeHyperlinkValue(match[1]);
            if (normalized) {
                links.add(normalized);
            }
        }

        const markdownWithoutExplicitLinks = markdown.replace(markdownLinkRegex, " ").replace(autoLinkRegex, " ");
        const bareUrlRegex = /(^|[\s(])((https?:\/\/|www\.)[^\s)>]+)/g;
        for (const match of markdownWithoutExplicitLinks.matchAll(bareUrlRegex)) {
            const normalized = normalizeHyperlinkValue(match[2]);
            if (normalized) {
                links.add(normalized);
            }
        }
    }

    return links.size > 0 ? [...links] : undefined;
}

function toReadableMarkdownLine(line: string): string {
    if (isMarkdownTableSeparatorRow(line) || isEmptyMarkdownTableRow(line)) {
        return "";
    }

    const tableRow = extractReadableTableRow(line);
    if (tableRow !== undefined) {
        return tableRow;
    }

    return normalizeReadableMarkdownInlineText(line);
}

function isEmptyMarkdownTableRow(line: string | undefined): boolean {
    if (typeof line !== "string") {
        return false;
    }

    const trimmed = line.trim();
    if (!trimmed.startsWith("|") || !trimmed.endsWith("|")) {
        return false;
    }

    const withoutPipes = trimmed.replace(/\|/g, "").trim();
    return withoutPipes.length === 0;
}

function isMarkdownTableSeparatorRow(line: string | undefined): boolean {
    if (typeof line !== "string") {
        return false;
    }

    const normalized = line.replace(/\|/g, " ").trim();
    return normalized.length > 0 && /^[:\-\s]+$/u.test(normalized);
}

function extractReadableTableRow(line: string): string | undefined {
    const trimmed = line.trim();
    if (!trimmed.includes("|")) {
        return undefined;
    }

    const tableLike = trimmed.startsWith("|") || trimmed.endsWith("|") || trimmed.split("|").length >= 3;
    if (!tableLike) {
        return undefined;
    }

    const cells = trimmed
        .replace(/^\|/u, "")
        .replace(/\|$/u, "")
        .split("|")
        .map((cell) => normalizeReadableMarkdownInlineText(cell))
        .filter((cell) => cell.length > 0);

    return cells.join(" ").trim();
}

function unescapeMarkdownPunctuation(value: string): string {
    return value
        .replace(/\\\\/g, "\\")
        .replace(/\\-/g, "-")
        .replace(/\\,/g, ",")
        .replace(/\\\./g, ".")
        .replace(/\\!/g, "!")
        .replace(/\\\|/g, "|")
        .replace(/\\\(/g, "(")
        .replace(/\\\)/g, ")")
        .replace(/\\\[/g, "[")
        .replace(/\\\]/g, "]")
        .replace(/\\#/g, "#")
        .replace(/\\\*/g, "*")
        .replace(/\\_/g, "_")
        .replace(/\\\{/g, "{")
        .replace(/\\\}/g, "}")
        .replace(/\\`/g, "`");
}

function normalizeHyperlinkValue(value: string | undefined): string | undefined {
    if (typeof value !== "string") {
        return undefined;
    }

    const cleaned = unescapeMarkdownPunctuation(value.trim()).replace(/[),.;]+$/u, "");
    if (!cleaned) {
        return undefined;
    }

    const withProtocol = /^https?:\/\//i.test(cleaned) ? cleaned : /^www\./i.test(cleaned) ? `https://${cleaned}` : "";
    const candidate = withProtocol || cleaned;
    return /^https?:\/\//i.test(candidate) ? candidate : undefined;
}

function normalizeReadableMarkdownInlineText(value: string): string {
    const withLinks = value
        .replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, (_match, label: string, url: string) => {
            const normalizedLabel = unescapeMarkdownPunctuation(String(label).trim());
            const normalizedUrl = normalizeHyperlinkValue(String(url));
            if (normalizedUrl && normalizedLabel && !normalizedLabel.includes(normalizedUrl)) {
                return `${normalizedLabel}: ${normalizedUrl}`;
            }
            return normalizedLabel || normalizedUrl || "";
        })
        .replace(/<(https?:\/\/[^>\s]+)>/g, (_match, url: string) => normalizeHyperlinkValue(String(url)) ?? "")
        .replace(/!\[[^\]]*]\([^)]+\)/g, " ");

    return stripOuterMarkdownEmphasis(
        stripMarkdownHeadingPrefix(unescapeMarkdownPunctuation(withLinks).replace(/[-:]{3,}/g, " "))
    )
        .replace(/\s+/g, " ")
        .trim();
}

function stripOuterMarkdownEmphasis(value: string): string {
    return value.replace(/^__(.+)__$/u, "$1").replace(/^\*\*(.+)\*\*$/u, "$1");
}

function stripMarkdownHeadingPrefix(value: string): string {
    return value.replace(/^#{1,6}\s+/u, "");
}
