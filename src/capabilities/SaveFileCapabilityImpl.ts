import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { WorkflowError, type AIClient, type AIRequest, type AIResponse, type NonStreamingExecutor } from "#root/index.js";

/**
 * Default capability key used when registering the save-file capability.
 *
 * @public
 */
export const DEFAULT_SAVE_FILE_CAPABILITY_KEY = "saveFile";

/**
 * Supported write payload formats.
 *
 * @public
 */
export type SaveFileContentType = "text" | "base64" | "json";

/**
 * Input shape for save-file requests.
 *
 * @public
 */
export interface SaveFileRequestInput {
    path: string;
    contentType?: SaveFileContentType;
    text?: string;
    base64?: string;
    json?: unknown;
    encoding?: BufferEncoding;
}

/**
 * Typed request alias for save-file operations.
 *
 * @public
 */
export type SaveFileRequest = AIRequest<SaveFileRequestInput>;

/**
 * Save-file operation output.
 *
 * @public
 */
export interface SaveFileOutput {
    path: string;
    bytesWritten: number;
    contentType: SaveFileContentType;
}

/**
 * Registration and runtime constraints for save-file capability.
 *
 * @public
 */
export interface RegisterSaveFileCapabilityOptions {
    capabilityKey?: string;
    baseDir?: string;
    allowAbsolutePath?: boolean;
    autoCreateDir?: boolean;
}

/**
 * Resolves the requested output path and enforces path constraints.
 *
 * @param requestedPath Caller-provided relative or absolute path
 * @param options Registration options controlling path behavior
 * @returns Resolved filesystem path to write
 * @throws {WorkflowError} When path is invalid, absolute path is disallowed, or path escapes baseDir
 * @private
 */
function resolveAndValidateOutputPath(requestedPath: string, options: RegisterSaveFileCapabilityOptions): string {
    if (!requestedPath || typeof requestedPath !== "string") {
        throw new WorkflowError("SaveFileCapability: input.path is required.");
    }

    const baseDir = options.baseDir ? path.resolve(options.baseDir) : undefined;
    const allowAbsolutePath = options.allowAbsolutePath ?? false;

    if (path.isAbsolute(requestedPath) && !allowAbsolutePath) {
        throw new WorkflowError("SaveFileCapability: absolute paths are not allowed.");
    }

    const resolved = baseDir ? path.resolve(baseDir, requestedPath) : path.resolve(requestedPath);
    if (baseDir && !resolved.startsWith(baseDir + path.sep) && resolved !== baseDir) {
        // Prevent path traversal outside constrained base directory.
        throw new WorkflowError(`SaveFileCapability: path escapes baseDir. path='${requestedPath}'`);
    }

    return resolved;
}

/**
 * Converts request input into a writeable payload.
 *
 * @param input Save-file request input
 * @returns Normalized content type and data payload
 * @throws {WorkflowError} When required fields for selected content type are missing
 * @private
 */
function normalizeContent(input: SaveFileRequestInput): { contentType: SaveFileContentType; data: string | Buffer } {
    const contentType = input.contentType ?? "text";

    if (contentType === "base64") {
        const base64 = input.base64;
        if (!base64 || typeof base64 !== "string") {
            throw new WorkflowError("SaveFileCapability: input.base64 is required for contentType 'base64'.");
        }
        return { contentType, data: Buffer.from(base64, "base64") };
    }

    if (contentType === "json") {
        return { contentType, data: JSON.stringify(input.json ?? null, null, 2) };
    }

    return { contentType: "text", data: String(input.text ?? "") };
}

/**
 * Registers a reusable save-file custom capability on AIClient.
 *
 * @param client AI client where executor will be registered
 * @param options Optional registration/runtime constraints
 * @returns Registered capability key
 * @public
 */
export function registerSaveFileCapability(
    client: AIClient,
    options: RegisterSaveFileCapabilityOptions = {}
): { capabilityKey: string } {
    const capabilityKey = options.capabilityKey ?? DEFAULT_SAVE_FILE_CAPABILITY_KEY;
    client.registerCapabilityExecutor(capabilityKey as any, createSaveFileExecutor(options, capabilityKey));
    return { capabilityKey };
}

/**
 * Creates a non-streaming save-file executor.
 *
 * @param options Registration and runtime constraints
 * @param capabilityKey Capability key used in executor metadata/id
 * @returns Non-streaming save-file executor
 * @public
 */
export function createSaveFileExecutor(
    options: RegisterSaveFileCapabilityOptions = {},
    capabilityKey: string = DEFAULT_SAVE_FILE_CAPABILITY_KEY
): NonStreamingExecutor<any, SaveFileRequestInput, SaveFileOutput> {
    const autoCreateDir = options.autoCreateDir ?? true;

    return {
        streaming: false,
        async invoke(_provider, request: AIRequest<SaveFileRequestInput>): Promise<AIResponse<SaveFileOutput>> {
            const input = request?.input;
            if (!input || typeof input !== "object") {
                throw new WorkflowError("SaveFileCapability: request.input is required.");
            }

            const outputPath = resolveAndValidateOutputPath(input.path, options);
            const { contentType, data } = normalizeContent(input);

            if (autoCreateDir) {
                await mkdir(path.dirname(outputPath), { recursive: true });
            }

            // Only text/json writes use an encoding option. Binary writes pass raw Buffer.
            const encoding = contentType === "text" || contentType === "json" ? (input.encoding ?? "utf8") : undefined;
            await writeFile(outputPath, data as any, encoding ? { encoding } : undefined);

            const bytesWritten = Buffer.isBuffer(data) ? data.byteLength : Buffer.byteLength(data, encoding ?? "utf8");

            return {
                output: {
                    path: outputPath,
                    bytesWritten,
                    contentType
                },
                rawResponse: { requestedPath: input.path },
                id: `${capabilityKey}-${Date.now()}`,
                metadata: { status: "completed", capabilityKey }
            };
        }
    };
}
