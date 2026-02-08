import fs from "fs";   
import path from "path";
import { ClientReferenceImage, ensureDataUri, NormalizedImage } from "#root/index.js";

export function saveFile(result: any, i: number) {
    const buffer = Buffer.from(result.output[i].base64!, "base64");
    fs.writeFileSync(`test_data/output-${result.output[i].id}_${i}.${result.metadata?.format || "png"}`, buffer);
    console.log(`Saved: test_data/output-${result.output[i].id}_${i}.${result.metadata?.format || "png"}`);
}

export function saveImageAsFile(images: NormalizedImage[], i: number) {
    const image = images[i];
    if (!image?.base64) {
        throw new Error("No image data to save");
    }

    const buffer = Buffer.from(image.base64, "base64");
    fs.writeFileSync(
        `test_data/output-${image.id ?? i}.png`,
        buffer
    );

    console.log(`Saved: test_data/output-${image.id ?? i}.png`);
}

export function loadImage(filePath: string, mimeType: string, role: string) {
    const fileBuffer = fs.readFileSync(filePath);
    const buffer = fileBuffer.toString("base64");
    const refImage: ClientReferenceImage = {
        id: crypto.randomUUID(),
        sourceType: "base64",
        base64: buffer,
        mimeType,
        url: ensureDataUri(buffer, mimeType),
        role: role as any
    };

    return refImage;
}

export function loadImageFromBuffer(buffer: string, mimeType: string, role: string) {
    //let fileBuffer = fs.readFileSync(filePath);
    //let buffer = fileBuffer.toString("base64");
    const refImage: ClientReferenceImage = {
        id: crypto.randomUUID(),
        sourceType: "base64",
        base64: buffer,
        mimeType,
        url: ensureDataUri(buffer, mimeType),
        role: role as any
    };

    return refImage;
}