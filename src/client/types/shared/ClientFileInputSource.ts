/**
 * @module client/types/shared/ClientFileInputSource.ts
 * @description Client-facing request and helper types.
 */

/**
 * Generic file/binary input source supported across browser and Node runtimes.
 *
 * Notes:
 * - Browser: File/Blob
 * - Node: Buffer/Uint8Array/ArrayBuffer/Readable stream
 * - Some providers may also accept local file paths, remote URLs, or data URLs
 *
 * @public
 */
export type ClientFileInputSource = File | Blob | Buffer | Uint8Array | ArrayBuffer | NodeJS.ReadableStream | string;
