/**
 * @module client/types/shared/OCRText.ts
 * @description ProviderPlaneAI source module.
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
 * @description Interface contract for OCRText.
 */
export interface OCRText {
    text: string;
    confidence?: number;
    boundingBox?: BoundingBox;
}
