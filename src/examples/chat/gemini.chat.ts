import { AIClient, ClientTextPart, MultiModalExecutionContext } from "#root/index.js";

export const gemini_chat = async () => {
    console.log("=== Gemini Chat ===");

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

    const result = await client.chat({
        input: {
            messages: [
                {
                    role: "user",
                    content: [{ type: "text", text: "Explain quantum computing in 4 lines." }]
                }
            ]
        }
    }, ctx, [{ providerType: "gemini", connectionName: "default" }]);

    return result.output;
}

export const gemini_chat_stream = async () => {
    console.log("=== Gemini Streaming Chat ===");

    const client = new AIClient();
    const ctx = new MultiModalExecutionContext();

    client.setLifeCycleHooks({
        onChunkEmitted: (info) => console.log(`\n[AI] Emitted chunk ${info.chunkIndex} → ${info.providerType}`),
        onExecutionStart: (info) => console.log(`\n[AI] Execution Start`),
        onExecutionFailure: (info) => console.log(`\n[AI] Execution Failure`),
        onExecutionEnd: (info) => console.log(`\n[AI] Execution End`),
        onAttemptStart: (info) => console.log(`\n[AI] Attempt ${info.attemptIndex} → ${info.providerType}`),
        onAttemptSuccess: (info) => console.log(`\n[AI] Success ${info.providerType} in ${info.durationMs}ms`),
        onAttemptFailure: (info) => console.warn(`\n[AI] Failure ${info.providerType}: ${info.error}`)
    });

    const controller = new AbortController();

    const timeout = setTimeout(() => {
        console.log("\n⛔ aborting stream\n");
        controller.abort();
    }, 1000*60*3);

    let accumulatedOutput: any = undefined;

    try {
        for await (const chunk of client.chatStream(
            {
                input: {
                    messages: [
                        {
                            role: "user",
                            content: [{ type: "text", text: "Tell me a short sci-fi story in 50 lines." }]
                        }
                    ]
                },
                signal: controller.signal
            },
            ctx,
            [{ providerType: "gemini", connectionName: "default" }]
        )) {
            // Each 'chunk' is AIResponseChunk<string>
            if (chunk.delta) {                
            //    process.stdout.write((chunk.delta.content[0] as ClientTextPart).text);
            }
            if (chunk.output) {
                accumulatedOutput = (chunk.output);
            }

            // Optional: stop manually if done
            if (chunk.done) break;
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

    console.log("\n=== Stream Finished ===\n");

    return accumulatedOutput;
}