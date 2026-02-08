import { saveImageAsFile } from "#root/examples/shared.js";
import { AIClient, MultiModalExecutionContext } from "#root/index.js";

export const gemini_image_gen = async () => {
    console.log("=== Gemini Image Generation ===");

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

    const generated = await client.generateImage(
        {
            input: {
                prompt: "A cinematic photo of a neon-lit cyberpunk street at night with a sneaky and fluffy cat",
                params: {
                    size: "1536x1024",
                    format: "png",
                    quality: "high"
                }
            }
        },
        ctx,
        [{ providerType: "gemini", connectionName: "default" }]
    );

    saveImageAsFile(generated.output, 0);

    return generated.output;
}

export const gemini_image_gen_stream = async () => {
    console.log("=== Gemini Streaming Image ===");

    const client = new AIClient();
    const ctx = new MultiModalExecutionContext();

    client.setLifeCycleHooks({
        onChunkEmitted: (info) => console.log(`[AI] Emitted chunk ${info.chunkIndex} → ${info.providerType}`),
        onExecutionStart: (info) => console.log(`[AI] Execution Start`),
        onExecutionFailure: (info) => console.log(`[AI] Execution Failure`),
        onExecutionEnd: (info) => console.log(`[AI] Execution End`),
        onAttemptStart: (info) => console.log(`[AI] Attempt ${info.attemptIndex} → ${info.providerType}`),
        onAttemptSuccess: (info) => console.log(`[AI] Success ${info.providerType} in ${info.durationMs}ms`),
        onAttemptFailure: (info) => console.warn(`[AI] Failure ${info.providerType}: ${info.error}`)
    });

    const controller = new AbortController();

    const timeout = setTimeout(() => {
        console.log("\n⛔ aborting stream\n");
        controller.abort();
    }, 1000 * 60 * 3);

    let output = [];
    try {
        for await (const chunk of client.generateImageStream(
            {
                input: {
                    prompt: "A cinematic photo of a neon-lit cyberpunk street at night with a sneaky and fluffy cat",
                    params: {
                        size: "1536x1024",
                        format: "png",
                        quality: "high"
                    }
                },
                signal: controller.signal
            },
            ctx,
            [{ providerType: "gemini", connectionName: "default" }]
        )) {
          if (chunk.error) {
              console.error("Gen failed:", chunk.error);
              break;
          }
  
          if (chunk.delta?.length) {
              for (const partial of chunk.delta) {
                 // console.log("Partial Gen:", partial);
              }
          }

            if(chunk.done && chunk.output?.length){
                output.push(...chunk.output);
            }
        }
    } catch (err) {
        if (controller.signal.aborted) {
            console.log("\nStream was aborted by user");
        } else {
            console.error("Stream error:", err);
        }
    } finally {
        clearTimeout(timeout)
    }
   
    saveImageAsFile(output, 0);

    console.log("\n=== Stream Finished ===\n");

    return output;
}