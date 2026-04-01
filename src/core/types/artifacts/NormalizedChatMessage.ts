/**
 * @module core/types/artifacts/NormalizedChatMessage.ts
 * @description Normalized multimodal chat message contracts.
 */
import { NormalizedArtifactBase } from "#root/index.js";

/**
 * Canonical, provider-normalized text part used in chat artifacts.
 */
/**
 * @public
 * Canonical provider-normalized text part.
 */
export interface NormalizedTextPart {
    type: "text";
    text: string;
}

/**
 * Canonical, provider-normalized image part used in chat artifacts.
 */
/**
 * @public
 * Canonical provider-normalized image part.
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
/**
 * @public
 * Canonical provider-normalized audio part.
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
/**
 * @public
 * Canonical provider-normalized video part.
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
/**
 * @public
 * Canonical provider-normalized file part.
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
/**
 * @public
 * Union type covering all normalized chat content parts.
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
/**
 * @public
 * Canonical provider-normalized chat message artifact.
 */
export interface NormalizedChatMessage extends NormalizedArtifactBase {
    role: "system" | "user" | "assistant";

    /**
     * Fully resolved multimodal content
     */
    content: NormalizedMessagePart[];
}
