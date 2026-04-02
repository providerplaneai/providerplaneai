import { describe, expect, it } from "vitest";
import {
    extractDataUriMimeType,
    getMimeTypeForExtensionOrFormat,
    inferMimeTypeFromFilename,
    isAudioMimeType,
    isImageMimeType,
    isLikelyImagePath,
    isPdfMimeType,
    isVideoMimeType
} from "#root/core/utils/MimeTypeUtils.js";

describe("MimeTypeUtils", () => {
    it("resolves MIME types from extensions, paths, and fallback values", () => {
        expect(getMimeTypeForExtensionOrFormat("png")).toBe("image/png");
        expect(getMimeTypeForExtensionOrFormat(".json")).toBe("application/json");
        expect(getMimeTypeForExtensionOrFormat("/tmp/file.heic")).toBe("image/heic");
        expect(getMimeTypeForExtensionOrFormat("unknown", "application/octet-stream")).toBe("application/octet-stream");
        expect(getMimeTypeForExtensionOrFormat("   ")).toBeUndefined();
        expect(getMimeTypeForExtensionOrFormat(undefined, "text/plain")).toBe("text/plain");
    });

    it("infers MIME types from filenames and paths", () => {
        expect(inferMimeTypeFromFilename("picture.jpeg")).toBe("image/jpeg");
        expect(inferMimeTypeFromFilename("movie.mp3")).toBe("audio/mpeg");
        expect(inferMimeTypeFromFilename("nested/path/document.odt")).toBe("application/vnd.oasis.opendocument.text");
        expect(inferMimeTypeFromFilename("no-extension", "application/octet-stream")).toBe("application/octet-stream");
    });

    it("extracts mime types from data URIs", () => {
        expect(extractDataUriMimeType("data:image/png;base64,AAAA")).toBe("image/png");
        expect(extractDataUriMimeType("data:text/plain,hello")).toBe("text/plain");
        expect(extractDataUriMimeType("not-a-data-uri")).toBeUndefined();
    });

    it("classifies image, audio, video, and PDF mime types", () => {
        expect(isImageMimeType("image/webp")).toBe(true);
        expect(isImageMimeType("text/plain")).toBe(false);
        expect(isAudioMimeType("audio/wav")).toBe(true);
        expect(isAudioMimeType("video/mp4")).toBe(false);
        expect(isVideoMimeType("video/mp4")).toBe(true);
        expect(isVideoMimeType("image/png")).toBe(false);
        expect(isPdfMimeType("application/pdf")).toBe(true);
        expect(isPdfMimeType("application/json")).toBe(false);
    });

    it("guesses whether a path likely points to an image", () => {
        expect(isLikelyImagePath("photo.jpeg")).toBe(true);
        expect(isLikelyImagePath("/tmp/diagram.svg")).toBe(true);
        expect(isLikelyImagePath("notes.txt")).toBe(false);
    });
});
