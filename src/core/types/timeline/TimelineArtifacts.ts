import { AudioArtifact, ChatArtifact, NormalizedImage, VideoArtifact } from "#root/index.js";

export interface TimelineArtifacts {
    images?: NormalizedImage[];
    masks?: NormalizedImage[];
    chat?: ChatArtifact[];
    audioArtifacts?: AudioArtifact[];
    videoArtifacts?: VideoArtifact[];

    files?: any[];
    [key: string]: unknown;
}
