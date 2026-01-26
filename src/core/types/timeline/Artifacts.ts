import { ClientMessagePart } from "#root/index.js";

export interface ChatArtifact {
    id: string;
    role: "system" | "user" | "assistant";
    content: ClientMessagePart[];
    turnIndex: number;
}

export interface AudioArtifact {
    id: string;
    mimeType: string;
    url?: string;
    base64?: string;
    raw?: unknown;
}

export interface VideoArtifact {
    id: string;
    mimeType: string;
    url?: string;
    base64?: string;
    raw?: unknown;
}
