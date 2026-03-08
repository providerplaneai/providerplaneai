import { NormalizedAudio } from "#root/index.js";

export type AudioArtifactParams = {
    id?: string;
    kind?: NormalizedAudio["kind"];
    mimeType: string;
    url?: string;
    base64?: string;
    transcript?: string;
    durationSeconds?: number;
    sampleRateHz?: number;
    channels?: number;
    bitrate?: number;
    raw?: unknown;
};

export function createAudioArtifact(params: AudioArtifactParams): NormalizedAudio {
    return {
        id: params.id ?? crypto.randomUUID(),
        ...(params.kind ? { kind: params.kind } : {}),
        mimeType: params.mimeType,
        ...(params.url ? { url: params.url } : {}),
        ...(params.base64 ? { base64: params.base64 } : {}),
        ...(params.transcript ? { transcript: params.transcript } : {}),
        ...(params.durationSeconds !== undefined ? { durationSeconds: params.durationSeconds } : {}),
        ...(params.sampleRateHz !== undefined ? { sampleRateHz: params.sampleRateHz } : {}),
        ...(params.channels !== undefined ? { channels: params.channels } : {}),
        ...(params.bitrate !== undefined ? { bitrate: params.bitrate } : {}),
        ...(params.raw !== undefined ? { raw: params.raw } : {})
    };
}
