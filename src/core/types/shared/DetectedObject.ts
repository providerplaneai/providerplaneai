/**
 * @module core/types/shared/DetectedObject.ts
 * @description Core shared type definitions used by runtime, providers, and workflows.
 */
import { BoundingBox } from "#root/index.js";

/**
 * Represents a detected object in an image or video frame.
 *
 * - `label`: Object class or label.
 * - `confidence`: Optional confidence score.
 * - `boundingBox`: Optional bounding box for the object.
 */
/**
 * @public
 * @description Interface contract for DetectedObject.
 */
export interface DetectedObject {
    label: string;
    confidence?: number;
    boundingBox?: BoundingBox;
}
