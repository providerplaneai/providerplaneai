/**
 * @module core/types/shared/BoundingBox.ts
 * @description Shared normalized bounding-box contract.
 */
/**
 * Axis-aligned bounding box in normalized image coordinates.
 *
 * All values are in the range [0, 1], relative to the full image size.
 * This makes bounding boxes resolution-independent and provider-agnostic.
 * Used for object detection, OCR, and region annotation.
 */
/**
 * @public
 * Axis-aligned bounding box in normalized image coordinates.
 */
export interface BoundingBox {
    /**
     * Left edge (x coordinate)
     */
    x: number;
    /**
     * Top edge (y coordinate)
     */
    y: number;
    /**
     * Width of the box
     */
    width: number;
    /**
     * Height of the box
     */
    height: number;
}
