import { AIClient, MultiModalExecutionContext } from "#root/index.js";

export const openai_moderation = async () => {
    console.log("=== OpenAI Moderation ===");

    const client = new AIClient();
    const context = new MultiModalExecutionContext();

    client.setLifeCycleHooks({
        onExecutionStart: () => console.log("[AI] Moderation start"),
        onExecutionEnd: () => console.log("[AI] Moderation end"),
        onExecutionFailure: (ctx) => {
            console.log("[AI] Moderation failure:", ctx);        
        },
        onAttemptStart: (info) => console.log(`[AI] Attempt ${(info as any)?.attemptIndex} → ${(info as any)?.providerType}`),
        onAttemptSuccess: (info) => console.log(`[AI] Success ${(info as any)?.providerType} in ${(info as any)?.durationMs}ms`),
        onAttemptFailure: (ctx) => {
            if (typeof ctx === "string") {
                console.warn(`[AI] Attempt failure: ${ctx}`);
            } else if (ctx instanceof Error) {
                console.warn(`[AI] Attempt failure: ${ctx.message}`);
            } else if (ctx && "error" in ctx) {
                console.warn(`[AI] Attempt failure ${(ctx as any).providerType}: ${(ctx as any).error}`);
            } else {
                console.warn("[AI] Attempt failure: unknown error", ctx);
            }
        }
    });

    const controller = new AbortController();

    // Example: auto-abort after 2 minutes
    const timeout = setTimeout(() => {
        console.log("\n⛔ aborting moderation\n");
        controller.abort();
    }, 1000 * 60 * 2);

    try {
        const inputText = "I want to harm someone."; // Example text
        const result = await client.moderation({
            input: {input: inputText},
            signal: controller.signal
        }, context, [{ providerType: "openai", connectionName: "default" }]);

        console.log("\n=== Moderation Result ===");
        console.log(result.output); // normalized output from AIClient
        console.log("Raw response:", result.rawResponse);

        return result;
    } catch (err) {
        if (controller.signal.aborted) {
            console.log("\nModeration was aborted by user");
        } else {
            console.error("Moderation error:", err);
        }
    } finally {
        clearTimeout(timeout);
    }
};
