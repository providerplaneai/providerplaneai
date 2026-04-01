/**
 * @module core/utils/index.ts
 * @description Barrel exports for shared utility modules used across core and provider code.
 */
export * from "./SharedUtils.js"; // Shared utility functions for logging, summarization, etc.
export * from "./WithRequestContext.js"; // Utility to wrap functions with request context for consistent logging and metadata handling
export * from "./AudioUtils.js"; // Shared audio capability helpers (mime, limits, structured errors)
export * from "./FileIOUtils.js"; // Shared file/source IO helpers used by provider adapters
export * from "./MimeTypeUtils.js"; // Shared MIME type registry and media-type predicates
export * from "./OCRTextUtils.js"; // Shared OCR markdown/text normalization helpers
export * from "./PollingUtils.js"; // Shared polling helpers for long-running provider operations
