import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { WorkflowError, type AIClient, type AIRequest, type AIResponse, type NonStreamingExecutor } from "#root/index.js";

export const DEFAULT_SAVE_FILE_CAPABILITY_KEY = "saveFile";

export type SaveFileContentType = "text" | "base64" | "json";

export interface SaveFileRequestInput {
    path: string;
    contentType?: SaveFileContentType;
    text?: string;
    base64?: string;
    json?: unknown;
    encoding?: BufferEncoding;
}

export type SaveFileRequest = AIRequest<SaveFileRequestInput>;

export interface SaveFileOutput {
    path: string;
    bytesWritten: number;
    contentType: SaveFileContentType;
}

export interface RegisterSaveFileCapabilityOptions {
    capabilityKey?: string;
    baseDir?: string;
    allowAbsolutePath?: boolean;
    autoCreateDir?: boolean;
}

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
        throw new WorkflowError(`SaveFileCapability: path escapes baseDir. path='${requestedPath}'`);
    }

    return resolved;
}

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

export function registerSaveFileCapability(
    client: AIClient,
    options: RegisterSaveFileCapabilityOptions = {}
): { capabilityKey: string } {
    const capabilityKey = options.capabilityKey ?? DEFAULT_SAVE_FILE_CAPABILITY_KEY;
    client.registerCapabilityExecutor(capabilityKey as any, createSaveFileExecutor(options, capabilityKey));
    return { capabilityKey };
}

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
