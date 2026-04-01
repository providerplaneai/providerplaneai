/**
 * @module providers/mistral/capabilities/shared/MistralOCROutputUtils.ts
 * @description Shared Mistral OCR output-normalization helpers.
 */
import type { OCRPageObject, OCRResponse } from "@mistralai/mistralai/models/components";
import {
    AIProvider,
    BoundingBox,
    ClientOCRRequest,
    NormalizedOCRDocument,
    OCRText,
    buildMetadata,
    extractReadableTextFromOCRMarkdown,
    normalizeOCRMarkdownTableOutput,
    resolveOCRMarkdownHyperlinks
} from "#root/index.js";

/**
 * Normalizes a raw Mistral OCR response into the project-wide OCR artifact shape.
 *
 * @param {OCRResponse} response - Raw provider OCR response.
 * @param {ClientOCRRequest} input - Original OCR request input.
 * @param {string | undefined} requestId - Optional request identifier to preserve.
 * @returns {NormalizedOCRDocument} Normalized OCR document artifact.
 */
export function normalizeMistralOCRResponse(
    response: OCRResponse,
    input: ClientOCRRequest,
    requestId?: string
): NormalizedOCRDocument {
    const pages = response.pages.map((page) => normalizeMistralOCRPage(page));
    const pageTexts = pages
        .map((page) => page.fullText)
        .filter((value): value is string => typeof value === "string" && value.length > 0);
    const fullText = pageTexts.join("\n\n").trim();
    const rawDocumentMarkdown = response.pages
        .map((page) => page.markdown)
        .filter(Boolean)
        .join("\n\n")
        .trim();
    const annotations = normalizeMistralOCRAnnotations(response);
    const tables = normalizeMistralOCRTables(response);
    const headers = normalizeMistralOCRPageSections(response.pages, "header");
    const footers = normalizeMistralOCRPageSections(response.pages, "footer");

    return {
        id: requestId ?? crypto.randomUUID(),
        fullText: fullText || undefined,
        text: pages.length === 1 ? pages[0]?.text : (pageTexts.map((text) => ({ text })) satisfies OCRText[]),
        pages,
        language: input.language,
        pageCount: pages.length,
        fileName: input.filename,
        mimeType: input.mimeType,
        sourceImageId: input.images?.[0]?.id,
        annotations,
        tables,
        headers,
        footers,
        rawDocumentMarkdown: rawDocumentMarkdown || undefined,
        metadata: buildMetadata(undefined, {
            provider: AIProvider.Mistral,
            model: response.model,
            status: "completed",
            pagesProcessed: response.usageInfo?.pagesProcessed
        })
    };
}

function normalizeMistralOCRPage(page: OCRPageObject): NonNullable<NormalizedOCRDocument["pages"]>[number] {
    const fullText = buildMistralOCRPageText(page).trim();
    const normalizedMarkdown = normalizeOCRMarkdownTableOutput(page.markdown);
    const hyperlinks = resolveOCRMarkdownHyperlinks(normalizedMarkdown, page.hyperlinks);

    return {
        pageNumber: page.index + 1,
        fullText: fullText || undefined,
        text: fullText ? [{ text: fullText }] : undefined,
        metadata: buildMetadata(undefined, {
            markdown: normalizedMarkdown || undefined,
            header: page.header,
            footer: page.footer,
            hyperlinks,
            dimensions: page.dimensions,
            imageCount: page.images.length,
            tableCount: page.tables?.length ?? 0
        })
    };
}

function normalizeMistralOCRAnnotations(response: OCRResponse): NormalizedOCRDocument["annotations"] {
    const annotations: NonNullable<NormalizedOCRDocument["annotations"]> = [];

    if (typeof response.documentAnnotation === "string" && response.documentAnnotation.trim().length > 0) {
        const text = response.documentAnnotation.trim();
        annotations.push({
            type: "document",
            text,
            data: tryParseAnnotationJson(text)
        });
    }

    response.pages.forEach((page, pageIndex) => {
        for (const image of page.images ?? []) {
            if (typeof image.imageAnnotation !== "string" || image.imageAnnotation.trim().length === 0) {
                continue;
            }

            annotations.push({
                type: "bbox",
                text: image.imageAnnotation.trim(),
                pageNumber: pageIndex + 1,
                bbox: toBoundingBox(image.topLeftX, image.topLeftY, image.bottomRightX, image.bottomRightY),
                metadata: buildMetadata(undefined, {
                    imageId: image.id
                })
            });
        }
    });

    return annotations.length ? annotations : undefined;
}

/**
 * Best-effort JSON parser for structured annotation payloads embedded in provider text fields.
 *
 * @param {string} value - Annotation text to parse.
 * @returns {Record<string, unknown> | unknown[] | undefined} Parsed structured payload when valid JSON is present.
 */
export function tryParseAnnotationJson(value: string): Record<string, unknown> | unknown[] | undefined {
    try {
        const parsed = JSON.parse(value) as unknown;
        if (Array.isArray(parsed)) {
            return parsed;
        }
        if (parsed && typeof parsed === "object") {
            return parsed as Record<string, unknown>;
        }
        return undefined;
    } catch {
        return undefined;
    }
}

function normalizeMistralOCRTables(response: OCRResponse): NormalizedOCRDocument["tables"] {
    const tables = response.pages.flatMap((page, pageIndex) =>
        (page.tables ?? [])
            .filter(
                (table) =>
                    typeof table.content === "string" &&
                    table.content.trim().length > 0 &&
                    (table.format === "markdown" || table.format === "html")
            )
            .map((table) => ({
                pageNumber: pageIndex + 1,
                format: table.format as "markdown" | "html",
                content: table.format === "markdown" ? normalizeOCRMarkdownTableOutput(table.content) : table.content.trim()
            }))
    );

    return tables.length ? tables : undefined;
}

function normalizeMistralOCRPageSections(
    pages: OCRPageObject[],
    key: "header" | "footer"
): NormalizedOCRDocument["headers"] | NormalizedOCRDocument["footers"] {
    const sections = pages
        .map((page, pageIndex) => {
            const text = typeof page[key] === "string" ? page[key].trim() : "";
            if (!text) {
                return undefined;
            }

            return {
                pageNumber: pageIndex + 1,
                text
            };
        })
        .filter((value): value is { pageNumber: number; text: string } => Boolean(value));

    return sections.length ? sections : undefined;
}

function buildMistralOCRPageText(page: OCRPageObject): string {
    const parts = [page.header, extractReadableTextFromOCRMarkdown(normalizeOCRMarkdownTableOutput(page.markdown)), page.footer]
        .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
        .map((value) => value.trim());

    return parts.join("\n").trim();
}

function toBoundingBox(
    left?: number | null,
    top?: number | null,
    right?: number | null,
    bottom?: number | null
): BoundingBox | undefined {
    if ([left, top, right, bottom].some((value) => typeof value !== "number")) {
        return undefined;
    }

    const x1 = left as number;
    const y1 = top as number;
    const x2 = right as number;
    const y2 = bottom as number;
    if (x2 <= x1 || y2 <= y1) {
        return undefined;
    }

    return {
        x: x1,
        y: y1,
        width: x2 - x1,
        height: y2 - y1
    };
}
