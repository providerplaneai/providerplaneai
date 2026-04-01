/**
 * @module core/types/shared/OCRText.ts
 * @description Shared OCR text-span contract.
 */
import { BoundingBox } from "#root/index.js";

/**
 * Represents a recognized text region from OCR (Optical Character Recognition).
 *
 * - `text`: The recognized text string.
 * - `confidence`: Optional confidence score.
 * - `boundingBox`: Optional bounding box for the text region.
 */
/**
 * @public
 * Normalized OCR text span.
 */
export interface OCRText {
    text: string;
    confidence?: number;
    boundingBox?: BoundingBox;
}
