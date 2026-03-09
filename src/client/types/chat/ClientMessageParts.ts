/**
 * @module client/types/chat/ClientMessageParts.ts
 * @description ProviderPlaneAI source module.
 */
/**
 * A single text message part for chat content.
 * Used to compose ClientChatMessage content.
 */
/**
 * @public
 * @description Interface contract for ClientTextPart.
 */
export interface ClientTextPart {
    type: "text";
    text: string;
}

/**
 * A single image message part for chat content.
 */
/**
 * @public
 * @description Interface contract for ClientImagePart.
 */
export interface ClientImagePart {
    type: "image";
    url?: string;
    base64?: string;
    caption?: string;
    mimeType?: string;
}

/**
 * A single audio message part for chat content.
 */
/**
 * @public
 * @description Interface contract for ClientAudioPart.
 */
export interface ClientAudioPart {
    type: "audio";
    url?: string;
    base64?: string;
    mimeType?: string;
}

/**
 * A single video message part for chat content.
 */
/**
 * @public
 * @description Interface contract for ClientVideoPart.
 */
export interface ClientVideoPart {
    type: "video";
    url?: string;
    base64?: string;
    mimeType?: string;
}

/**
 * A single file message part for chat content.
 */
/**
 * @public
 * @description Interface contract for ClientFilePart.
 */
export interface ClientFilePart {
    type: "file";
    url?: string;
    base64?: string;
    mimeType?: string;
    filename?: string;
}

/**
 * Union type for all supported message part types (text, image, audio, video, file).
 * Ensures type safety when building messages for chat requests.
 */
/**
 * @public
 * @description Type alias for ClientMessagePart.
 */
export type ClientMessagePart = ClientTextPart | ClientImagePart | ClientAudioPart | ClientVideoPart | ClientFilePart;
