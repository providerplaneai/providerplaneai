/**
 * @module client/types/chat/ClientMessageParts.ts
 * @description Typed multimodal message parts used by provider-agnostic chat requests.
 */
/**
 * Text segment within a chat message payload.
 *
 * @public
 */
export interface ClientTextPart {
    type: "text";
    text: string;
}

/**
 * Image segment within a chat message payload.
 *
 * @public
 */
export interface ClientImagePart {
    type: "image";
    url?: string;
    base64?: string;
    caption?: string;
    mimeType?: string;
}

/**
 * Audio segment within a chat message payload.
 *
 * @public
 */
export interface ClientAudioPart {
    type: "audio";
    url?: string;
    base64?: string;
    mimeType?: string;
}

/**
 * Video segment within a chat message payload.
 *
 * @public
 */
export interface ClientVideoPart {
    type: "video";
    url?: string;
    base64?: string;
    mimeType?: string;
}

/**
 * Generic file segment within a chat message payload.
 *
 * @public
 */
export interface ClientFilePart {
    type: "file";
    url?: string;
    base64?: string;
    mimeType?: string;
    filename?: string;
}

/**
 * Union of every supported multimodal chat message part.
 *
 * @public
 */
export type ClientMessagePart = ClientTextPart | ClientImagePart | ClientAudioPart | ClientVideoPart | ClientFilePart;
