import { describe, expect, it } from "vitest";

const modulePaths = [
    "#root/core/types/AIRequest.js",
    "#root/core/types/AIResponse.js",
    "#root/core/types/Config.js",
    "#root/core/types/MultiModalExecutionContext.js",
    "#root/core/types/NormalizedUserInput.js",
    "#root/core/types/artifacts/NormalizedArtifactBase.js",
    "#root/core/types/artifacts/NormalizedAudio.js",
    "#root/core/types/artifacts/NormalizedChatMessage.js",
    "#root/core/types/artifacts/NormalizedEmbedding.js",
    "#root/core/types/artifacts/NormalizedFile.js",
    "#root/core/types/artifacts/NormalizedImage.js",
    "#root/core/types/artifacts/NormalizedImageAnalysis.js",
    "#root/core/types/artifacts/NormalizedMask.js",
    "#root/core/types/artifacts/NormalizedModeration.js",
    "#root/core/types/artifacts/NormalizedVideo.js",
    "#root/core/types/artifacts/index.js",
    "#root/core/types/exceptions/AllProvidersFailedError.js",
    "#root/core/types/exceptions/CapabilityUnsupportedError.js",
    "#root/core/types/exceptions/DuplicateProviderRegistrationError.js",
    "#root/core/types/exceptions/ExecutionPolicyError.js",
    "#root/core/types/exceptions/index.js",
    "#root/core/types/index.js",
    "#root/core/types/jobs/Job.js",
    "#root/core/types/jobs/JobSnapshot.js",
    "#root/core/types/jobs/index.js",
    "#root/core/types/timeline/TimelineArtifacts.js",
    "#root/core/types/timeline/TimelineEvents.js",
    "#root/core/types/timeline/TimelineSnapshot.js",
    "#root/core/types/timeline/index.js",
    "#root/core/types/workflow/WorkflowTypes.js",
    "#root/core/types/workflow/index.js",
    "#root/core/jobs/GenericJob.js",
    "#root/core/jobs/JobManager.js",
    "#root/core/jobs/index.js"
];

describe("core/types module coverage", () => {
    it("imports every src/core/types module path", async () => {
        for (const modulePath of modulePaths) {
            const mod = await import(modulePath);
            expect(mod).toBeTypeOf("object");
        }
    });
});
