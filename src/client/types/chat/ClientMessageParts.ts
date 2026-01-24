/**
 * A single text message part for chat content.
 * Used to compose ClientChatMessage content.
 */
export interface ClientTextPart {
    type: "text";
    text: string;
}

/**
 * A single image message part for chat content.
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
export interface ClientAudioPart {
    type: "audio";
    url?: string;
    base64?: string;
    mimeType?: string;
}

/**
 * A single video message part for chat content.
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
export type ClientMessagePart = ClientTextPart | ClientImagePart | ClientAudioPart | ClientVideoPart | ClientFilePart;
