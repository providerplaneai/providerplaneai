import { AIClient, AIRequest, CapabilityKeys, ClientChatRequest, ClientTextPart, JobChunk, MultiModalExecutionContext, NormalizedChatMessage } from "#root/index.js";

export const openai_chat = async () => {
    console.log("=== OpenAI Chat ===");

    const client = new AIClient();
    client.setLifeCycleHooks({
        onChunkEmitted: (ctx) => console.log(`[AI] Emitted ${ctx.chunkIndex} → ${ctx.providerType}`),
        onExecutionStart: (ctx) => console.log(`[AI] Execution Start ${ctx}`),
        onExecutionFailure: (ctx) => console.log(`[AI] Execution Failure ${ctx}`),
        onExecutionEnd: (ctx) => console.log(`[AI] Execution End ${ctx}`),
        onAttemptStart: (ctx) => console.log(`[AI] Attempt ${ctx.attemptIndex} → ${ctx.providerType}`),
        onAttemptSuccess: (ctx) => console.log(`[AI] Success ${ctx.providerType} in ${ctx.durationMs}ms`),
        onAttemptFailure: (ctx) => console.warn(`[AI] Failure ${ctx.providerType}: ${ctx.error}`)
    });

    const request: ClientChatRequest = {
        messages: [
            {
                role: "user",
                content: [{ type: "text", text: "Explain jobs vs workflows" }]
            }
        ]
    };

    // Create the job (nothing runs yet)
    const job = client.createCapabilityJob(
        CapabilityKeys.ChatCapabilityKey,
        { input: request }
    );

    // Later (or immediately), run it
    const ctx = new MultiModalExecutionContext();

    await job.run(ctx);

    // Final result
    console.log(job);

    return job.output
}

export const openai_chat_stream = async () => {
    console.log("=== OpenAI Streaming Chat ===");

    const client = new AIClient();
    client.setLifeCycleHooks({
        onChunkEmitted: (ctx) => console.log(`[AI] Emitted ${ctx.chunkIndex} → ${ctx.providerType}`),
        onExecutionStart: (ctx) => console.log(`[AI] Execution Start ${ctx}`),
        onExecutionFailure: (ctx) => console.log(`[AI] Execution Failure ${ctx}`),
        onExecutionEnd: (ctx) => console.log(`[AI] Execution End ${ctx}`),
        onAttemptStart: (ctx) => console.log(`[AI] Attempt ${ctx.attemptIndex} → ${ctx.providerType}`),
        onAttemptSuccess: (ctx) => console.log(`[AI] Success ${ctx.providerType} in ${ctx.durationMs}ms`),
        onAttemptFailure: (ctx) => console.warn(`[AI] Failure ${ctx.providerType}: ${ctx.error}`)
    });

    const request: ClientChatRequest = {
        messages: [
            {
                role: "user",
                content: [{ type: "text", text: "Explain quantum mechanics in 10 sentences" }]
            }
        ]
    };

    const job = client.createCapabilityJob(
        CapabilityKeys.ChatStreamCapabilityKey,
        { input: request }
    );    

    /*job.onChunk = (chunk) => {
        if (chunk.delta) {
            console.log("delta:", chunk.delta);
        }
    };*/

   /* await client.jobManager.runJob(job.id, new MultiModalExecutionContext(), undefined, (chunk: JobChunk<any>) => {
        if (chunk.delta) {
            console.log("chunk callback delta:", chunk.delta);
        }
    });
*/
    //const ctx = new MultiModalExecutionContext();
    //await job.run(ctx);

    // Final result
    console.log(job);

    return job.output    
}

export const openai_chat_old = async () => {
    console.log("=== OpenAI Chat ===");

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
    }, ctx, [{ providerType: "openai", connectionName: "default" }]);

    return result.output;
}

export const openai_chat_stream_old = async () => {
    console.log("=== OpenAI Streaming Chat ===");

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

    let accumulatedOutput: any = undefined;

    try {
        for await (const chunk of client.chatStream(
            {
                input: {
                    messages: [
                        {
                            role: "user",
                            content: [{ type: "text", text: "Explain quantum computing in 8 lines." }]
                        }
                    ]
                },
                signal: controller.signal
            },
            ctx,
            [{ providerType: "openai", connectionName: "default" }]
        )) {
            // Each 'chunk' is AIResponseChunk<string>
            if (chunk.delta) {
                process.stdout.write((chunk.delta.content[0] as ClientTextPart).text);
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