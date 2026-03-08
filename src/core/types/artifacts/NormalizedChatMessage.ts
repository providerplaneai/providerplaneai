import { NormalizedArtifactBase } from "#root/index.js";

/**
 * Canonical, provider-normalized text part used in chat artifacts.
 */
export interface NormalizedTextPart {
    type: "text";
    text: string;
}

/**
 * Canonical, provider-normalized image part used in chat artifacts.
 */
export interface NormalizedImagePart {
    type: "image";
    url?: string;
    base64?: string;
    caption?: string;
    mimeType?: string;
}

/**
 * Canonical, provider-normalized audio part used in chat artifacts.
 */
export interface NormalizedAudioPart {
    type: "audio";
    url?: string;
    base64?: string;
    mimeType?: string;
}

/**
 * Canonical, provider-normalized video part used in chat artifacts.
 */
export interface NormalizedVideoPart {
    type: "video";
    url?: string;
    base64?: string;
    mimeType?: string;
}

/**
 * Canonical, provider-normalized file part used in chat artifacts.
 */
export interface NormalizedFilePart {
    type: "file";
    url?: string;
    base64?: string;
    mimeType?: string;
    filename?: string;
}

/**
 * Union type for all normalized chat content parts.
 */
export type NormalizedMessagePart =
    | NormalizedTextPart
    | NormalizedImagePart
    | NormalizedAudioPart
    | NormalizedVideoPart
    | NormalizedFilePart;

/**
 * Canonical, provider-normalized chat message.
 * Stored in timeline artifacts.
 */
export interface NormalizedChatMessage extends NormalizedArtifactBase {
    role: "system" | "user" | "assistant";

    /**
     * Fully resolved multimodal content
     */
    content: NormalizedMessagePart[];
}
