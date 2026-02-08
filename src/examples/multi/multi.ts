import path from "path";
import { loadImage, saveFile, saveImageAsFile } from "../shared.js";
import { openai_image_edit } from "../images/edit/openai.imageedit.js";
import { AIClient, MultiModalExecutionContext, NormalizedImageAnalysis } from "#root/index.js";
import { openai_image_analysis } from "../images/analysis/openai.analysis.js";

export const runMultiImageEdit = async () => {
    console.log("=== Multi Modal Image Edit ===");

    const context = new MultiModalExecutionContext();
    const client = new AIClient();

    // First edit
    await openai_image_edit(context);

    // Second edit in the same context

    const controller = new AbortController();

    const timeout = setTimeout(() => {
        console.log("\n⛔ aborting request\n");
        controller.abort();
    }, 1000 * 60 * 3);

    try {
        const result = await client.editImage(
            {
                input: {
                    prompt: "Make it look like a watercolor painting",
                }
            },
            context,
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
}

export const runMultiImageEdit2 = async () => {
    console.log("=== Multi Modal Image Edit 2 ===");

    const context = new MultiModalExecutionContext();
    const client = new AIClient();


    const controller = new AbortController();

    const timeout = setTimeout(() => {
        console.log("\n⛔ aborting request\n");
        controller.abort();
    }, 1000 * 60 * 3);

    // First edit
    await openai_image_edit(context);

    // analysis step
    console.log("=== Multi Modal Image Edit 2 - analysis ===");
    console.log("Using the edited image for analysis");

    try {
        const result = await client.analyzeImage(
            {
                input: {
                    prompt: "Describe the mood, lighting, and artistic style of this image"
                },
                signal: controller.signal
            },
            context,
            [{ providerType: "openai", connectionName: "default" }]
        );

        console.log("Analysis result:");
        const analysisResult = result;
        console.log(analysisResult);
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

    console.log("=== Multi Modal Image Edit 2 - edit 2 ===");
    console.log("Using the edited image for editing again");

    // Second edit in the same context
    try {
        const result = await client.editImage(
            {
                input: {
                    prompt: "Make it look like a watercolor painting",
                }
            },
            context,
            [{ providerType: "openai", connectionName: "default" }]
        );

        saveFile(result, 0);

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

    console.log("=== Multi Modal Image Edit 2 - analysis 2 ===");
    console.log("Using the edited image for analysis");

    try {
        const result = await client.analyzeImage(
            {
                input: {
                    prompt: "Describe the mood, lighting, and artistic style of this image"
                },
                signal: controller.signal
            },
            context,
            [{ providerType: "openai", connectionName: "default" }]
        );

        console.log("Analysis result:");
        const analysisResult = result;
        console.log(analysisResult);
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
}

export const runMultiImageEdit3 = async () => {
    console.log("=== Multi Modal, Multi provider Image Edit ===");

    const context = new MultiModalExecutionContext();
    const client = new AIClient();

    const controller = new AbortController();

    const timeout = setTimeout(() => {
        console.log("\n⛔ aborting request\n");
        controller.abort();
    }, 1000 * 60 * 3);

    // First edit
    await openai_image_edit(context);

    // Second edit in the same context

    console.log("=== Multi Modal Image Edit 3 - analysis 1 ===");
    console.log("Using the edited image for analysis");

    try {
        const result = await client.analyzeImage(
            {
                input: {
                    prompt: "Describe the mood, lighting, and artistic style of this image"
                },
                signal: controller.signal
            },
            context,
            [{ providerType: "gemini", connectionName: "default" }]
        );

        console.log("Analysis result:");
        const analysisResult = result;
        console.log(analysisResult);
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
}

export const runMultiImageEdit4 = async () => {
   /* console.log("=== Multi Modal, Multi provider Image Edit / Analyze / Chat ===");

    // edit (openai) -> analysis (gemini) -> chat (anthropic) -> generate (gemini or openai) 

    const context = new MultiModalExecutionContext();
    const client = new AIClient();

    const controller = new AbortController();

    const timeout = setTimeout(() => {
        console.log("\n⛔ aborting request\n");
        controller.abort();
    }, 1000 * 60 * 3);

    // First edit
    await openai_image_edit(context);

    // Second edit in the same context

    console.log("=== Multi Modal Image Edit 4 - analysis 1 ===");
    console.log("Using the edited image for analysis");

    let finalAnalyses: NormalizedImageAnalysis[] = [];
    try {
        const stream = client.analyzeImageStream(
            {
                input: {
                    prompt: "Describe the mood, lighting, and artistic style of this image"
                },
                signal: controller.signal
            },
            context,
            [{ providerType: "gemini", connectionName: "default" }]
        );


        for await (const chunk of stream) {
            if (chunk.error) {
                console.error("Analysis failed:", chunk.error);
                break;
            }

            if (chunk.done) {
                finalAnalyses = chunk.output ?? [];

                // Optional but recommended: persist into EC
                if (finalAnalyses.length) {
                    context.attachMultimodalArtifacts({
                        analysis: finalAnalyses
                    });
                }

                console.log("Analysis completed ✅");
                break;
            }
        }

        console.log("=== Final Normalized Analysis Result ===");
        console.log(finalAnalyses);
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

    console.log("=== Multi Modal Image Edit 4 - chat 1 ===");

    // Now use Anthropic to chat about the image based on the analysis description
*/
}