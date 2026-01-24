import { BoundingBox } from "#root/index.js";

/**
 * Represents a detected object in an image or video frame.
 *
 * - `label`: Object class or label.
 * - `confidence`: Optional confidence score.
 * - `boundingBox`: Optional bounding box for the object.
 */
export interface DetectedObject {
    label: string;
    confidence?: number;
    boundingBox?: BoundingBox;
}
