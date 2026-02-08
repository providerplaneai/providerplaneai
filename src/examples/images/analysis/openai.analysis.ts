import path from "path";
import { loadImage } from "#root/examples/shared.js";
import { AIClient, ClientReferenceImage, MultiModalExecutionContext } from "#root/index.js";

export const openai_image_analysis = async (ctx?:MultiModalExecutionContext) => {
    console.log("=== OpenAI Image Analysis ===");

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
        const result = await client.analyzeImage(
            {
                input: {
                    images: [subjectImage, maskImage]
                },
                signal: controller.signal
            },
            ctx,
            [{ providerType: "openai", connectionName: "default" }]
        );

        return result.output;
    } catch (err) {
        if (controller.signal.aborted) {
            console.log("\nRequest was aborted by user");
            return undefined;
        }

        console.error("Analysis failed:", err);
        throw err;
    } finally {
        clearTimeout(timeout);
    }
};


export const openai_image_analysis_stream = async () => {
    console.log("=== OpenAI Image Analysis Streaming ===");

    const client = new AIClient();
    const context = new MultiModalExecutionContext();

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
        console.log("\n⛔ aborting stream\n");
        controller.abort();
    }, 1000 * 60 * 3);

    let output;

    try {
        for await (const chunk of client.analyzeImageStream(
            {
                input: {
                    images: [subjectImage, maskImage]
                },
                signal: controller.signal
            },
            context,
            [{ providerType: "openai", connectionName: "default" }]
        )) {
            if (chunk.error) {
                console.error("Analysis failed:", chunk.error);
                break;
            }

            if (chunk.delta?.length) {
                for (const partial of chunk.delta) {
                    console.log("Partial Analysis:", partial);
                }

                output = chunk.output;
            }
        }
    } catch (err) {
        if (controller.signal.aborted) {
            console.log("\nStream was aborted by user");
        } else {
            console.error("Stream error:", err);
        }
    } finally {
        clearTimeout(timeout);
    }

    console.log("\n=== Stream Finished ===\n");

    return output;
}