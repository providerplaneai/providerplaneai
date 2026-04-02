/**
 * @module core/types/shared/DetectedObject.ts
 * @description Shared detected-object contract used by image and video analysis artifacts.
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
 * Normalized detected object description.
 */
export interface DetectedObject {
    label: string;
    confidence?: number;
    boundingBox?: BoundingBox;
}
