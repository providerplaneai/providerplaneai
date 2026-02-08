import path from "path";
import { loadImage, saveFile, saveImageAsFile } from "#root/examples/shared.js";
import { AIClient, ClientReferenceImage, MultiModalExecutionContext } from "#root/index.js";

export const openai_image_edit = async (ctx?: MultiModalExecutionContext) => {
    console.log("=== OpenAI Image Edit ===");

    const client = new AIClient();
    ctx ??= new MultiModalExecutionContext();

    client.setLifeCycleHooks({
        onChunkEmitted: (ctx) => console.log(`[AI] Emitted ${ctx.chunkIndex} → ${ctx.providerType}`),
        onExecutionStart: (ctx) => console.log(`[AI] Execution Start ${ctx}`),
        onExecutionFailure: (ctx) => console.log(`[AI] Execution Failure ${ctx}`),
        onExecutionEnd: (ctx) => console.log(`[AI] Execution End ${ctx}`),
        onAttemptStart: (ctx) => console.log(`[AI] Attempt ${ctx.attemptIndex} → ${ctx.providerType}`),
        onAttemptSuccess: (ctx) => console.log(`[AI] Success ${ctx.providerType} in ${ctx.durationMs}ms`),
        onAttemptFailure: (ctx) => console.warn(`[AI] Failure ${ctx.providerType}: ${ctx.error}`)
    });

    const subjectImage = loadImage(path.join("test_data/sunlit_lounge.png"), "image/png", "subject");
    const maskImage = loadImage(path.join("test_data/sunlit_mask.png"), "image/png", "reference");

    const controller = new AbortController();

    const timeout = setTimeout(() => {
        console.log("\n⛔ aborting request\n");
        controller.abort();
    }, 1000 * 60 * 3);

    try {
        const result = await client.editImage(
            {
                input: {
                    prompt: "Add a pink flamingo using the mask area",
                    referenceImages: [subjectImage, maskImage]
                }
            },
            ctx,
            [{ providerType: "openai", connectionName: "default" }]
        );

        saveImageAsFile(result.output, 0);

        return result.output;
    } catch (err) {
        if (controller.signal.aborted) {
            console.log("\nRequest was aborted by user");
            return undefined;
        }

        console.error("Image edit failed:", err);
        throw err;
    } finally {
        clearTimeout(timeout);
    }
};


export const openai_image_edit_stream = async () => {
    console.log("=== OpenAI Image Edit Streaming ===");

    const client = new AIClient();
    const ctx = new MultiModalExecutionContext();

    client.setLifeCycleHooks({
        onChunkEmitted: (ctx) => console.log(`[AI] Emitted ${ctx.chunkIndex} → ${ctx.providerType}`),
        onExecutionStart: (ctx) => console.log(`[AI] Execution Start ${ctx}`),
        onExecutionFailure: (ctx) => console.log(`[AI] Execution Failure ${ctx}`),
        onExecutionEnd: (ctx) => console.log(`[AI] Execution End ${ctx}`),
        onAttemptStart: (ctx) => console.log(`[AI] Attempt ${ctx.attemptIndex} → ${ctx.providerType}`),
        onAttemptSuccess: (ctx) => console.log(`[AI] Success ${ctx.providerType} in ${ctx.durationMs}ms`),
        onAttemptFailure: (ctx) => console.warn(`[AI] Failure ${ctx.providerType}: ${ctx.error}`)
    });

    const subjectImage = loadImage(path.join("test_data/sunlit_lounge.png"), "image/png", "subject");
    const maskImage = loadImage(path.join("test_data/sunlit_mask.png"), "image/png", "reference");

    const controller = new AbortController();

    const timeout = setTimeout(() => {
        console.log("\n⛔ aborting request\n");
        controller.abort();
    }, 1000 * 60 * 3);

    let result = {} as any;
    try {
        for await (const chunk of client.editImageStream(
            {
                input: {
                    prompt: "Add a pink flamingo using the mask area",
                    referenceImages: [subjectImage, maskImage]
                }
            },
            ctx,
            [{ providerType: "openai", connectionName: "default" }]
        )) {
            if (chunk.error) {
                console.error("Stream error:", chunk.error);
                break;
            }

            if (chunk.delta?.length) {
                for (const image of chunk.delta) {
                    console.log("Received image chunk:", image.url);
                }
            }

            if(chunk.output) {
                result = chunk;
                break;
            }

            if (chunk.done) {
                console.log("Image edit completed");
            }
        }

        saveImageAsFile(result.output, 0);

        return result.output;
    } catch (err) {
        if (controller.signal.aborted) {
            console.log("\nRequest was aborted by user");
            return undefined;
        }

        console.error("Image edit failed:", err);
        throw err;
    } finally {
        clearTimeout(timeout);
    }
};