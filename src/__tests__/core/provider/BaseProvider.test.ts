import { describe, expect, it } from "vitest";
import {
    AIProvider,
    BaseProvider,
    CapabilityUnsupportedError,
    type CapabilityExecutor,
    type CapabilityKeyType,
    type ProviderConnectionConfig
} from "#root/index.js";

class TestProvider extends BaseProvider {
    constructor() {
        super(AIProvider.OpenAI);
    }

    init(config: ProviderConnectionConfig) {
        this.config = config;
    }

    setConfig(config: ProviderConnectionConfig | null) {
        this.config = config;
    }

    exposeRegisterCapability(key: CapabilityKeyType, impl: unknown) {
        this.registerCapability(key as any, impl as any);
    }

    exposeMergeOptions(...sources: any[]) {
        return this.mergeOptions(...sources);
    }
}

function makeConfig(overrides: Partial<ProviderConnectionConfig> = {}): ProviderConnectionConfig {
    return {
        type: AIProvider.OpenAI,
        defaultModel: "model-default",
        defaultModels: {
            chat: "model-chat",
            embed: "model-embed"
        },
        providerDefaults: {
            modelParams: { temperature: 0.1, nested: { a: 1 }, arr: [1, 2] },
            providerParams: { region: "us" },
            generalParams: { timeoutMs: 1000 }
        },
        models: {
            "model-default": {
                chat: {
                    modelParams: { nested: { b: 2 } },
                    providerParams: { region: "eu" },
                    generalParams: { timeoutMs: 2000 }
                }
            },
            "model-chat": {
                chat: {
                    modelParams: { maxTokens: 128, nested: { a: 9, c: 3 }, arr: [9] },
                    providerParams: { endpoint: "chat-endpoint" },
                    generalParams: { retry: 2 }
                }
            },
            "model-embed": {
                embed: {
                    modelParams: { dimensions: 768 },
                    providerParams: { endpoint: "embed-endpoint" },
                    generalParams: { retry: 1 }
                }
            }
        },
        ...overrides
    };
}

describe("BaseProvider", () => {
    it("sets and returns provider type", () => {
        const provider = new TestProvider();
        expect(provider.providerType).toBe(AIProvider.OpenAI);
        expect(provider.getProviderType()).toBe(AIProvider.OpenAI);
    });

    it("base init throws not implemented", () => {
        class MinimalProvider extends BaseProvider {
            constructor() {
                super(AIProvider.OpenAI);
            }
        }
        const provider = new MinimalProvider();
        expect(() => provider.init(makeConfig())).toThrow("init() Not implemented");
    });

    it("tracks initialization state and ensureInitialized guard", () => {
        const provider = new TestProvider();
        expect(provider.isInitialized()).toBe(false);
        expect(() => provider.ensureInitialized()).toThrow("openai provider not initialized");

        provider.init(makeConfig());
        expect(provider.isInitialized()).toBe(true);
        expect(() => provider.ensureInitialized()).not.toThrow();
    });

    it("registers and resolves capabilities", () => {
        const provider = new TestProvider();
        const capabilityKey = "custom:cap";
        const impl = { run: "ok" };

        provider.exposeRegisterCapability(capabilityKey as any, impl);

        expect(provider.hasCapability(capabilityKey as any)).toBe(true);
        expect(provider.getCapability(capabilityKey as any)).toBe(impl);
        const capabilities = provider.getCapabilities() as Record<string, unknown>;
        expect(capabilities[capabilityKey]).toBe(impl);
    });

    it("resolves capabilities via client executors fallback", () => {
        const provider = new TestProvider();
        const capability = "custom:executor" as any;
        const executor = { streaming: false } as CapabilityExecutor<any, any, any>;
        const executors = new Map<CapabilityKeyType, CapabilityExecutor<any, any, any>>([[capability, executor]]);

        provider.setClientExecutors(executors);

        expect(provider.hasCapability(capability)).toBe(true);
        expect(provider.getCapability(capability)).toBe(executor as any);
    });

    it("throws CapabilityUnsupportedError when capability is missing", () => {
        const provider = new TestProvider();
        expect(() => provider.getCapability("missing:cap" as any)).toThrow(CapabilityUnsupportedError);
    });

    it("mergeOptions deep merges objects, overrides arrays, and skips nullish sources", () => {
        const provider = new TestProvider();
        const merged = provider.exposeMergeOptions(
            { a: 1, nested: { x: 1, y: 1 }, arr: [1, 2] },
            undefined,
            null,
            { a: 2, nested: { y: 9, z: 3 }, arr: [3], b: true }
        );

        expect(merged).toEqual({
            a: 2,
            nested: { x: 1, y: 9, z: 3 },
            arr: [3],
            b: true
        });
    });

    it("getMergedOptions throws when provider is not initialized", () => {
        const provider = new TestProvider();
        expect(() => provider.getMergedOptions("chat")).toThrow("openai provider not initialized");
    });

    it("getMergedOptions throws when model cannot be resolved", () => {
        const provider = new TestProvider();
        provider.init(
            makeConfig({
                defaultModel: undefined,
                defaultModels: {},
                models: {}
            })
        );

        expect(() => provider.getMergedOptions("chat")).toThrow("Unable to resolve model for capability='chat'");
    });

    it("getMergedOptions resolves model by runtime > defaultModels > defaultModel", () => {
        const provider = new TestProvider();
        provider.init(makeConfig());

        const fromRuntime = provider.getMergedOptions("chat", { model: "model-default" });
        expect(fromRuntime.model).toBe("model-default");

        const fromDefaultModels = provider.getMergedOptions("chat");
        expect(fromDefaultModels.model).toBe("model-chat");

        provider.init(
            makeConfig({
                defaultModels: {}
            })
        );
        const fromDefaultModel = provider.getMergedOptions("chat");
        expect(fromDefaultModel.model).toBe("model-default");
    });

    it("getMergedOptions merges provider defaults, model config, and runtime overrides", () => {
        const provider = new TestProvider();
        provider.init(makeConfig());

        const merged = provider.getMergedOptions("chat", {
            modelParams: { nested: { a: 42 }, runtimeOnly: true },
            providerParams: { endpoint: "runtime-endpoint" },
            generalParams: { timeoutMs: 9999 }
        });

        expect(merged.model).toBe("model-chat");
        expect(merged.modelParams).toEqual({
            temperature: 0.1,
            nested: { a: 42, c: 3 },
            arr: [9],
            maxTokens: 128,
            runtimeOnly: true
        });
        expect(merged.providerParams).toEqual({
            region: "us",
            endpoint: "runtime-endpoint"
        });
        expect(merged.generalParams).toEqual({
            timeoutMs: 9999,
            retry: 2
        });
    });

    it("getMergedOptions handles model missing capability block by using defaults + runtime", () => {
        const provider = new TestProvider();
        provider.init(makeConfig());

        const merged = provider.getMergedOptions("nonexistentCapability", {
            model: "model-chat",
            modelParams: { x: 1 }
        });

        expect(merged.model).toBe("model-chat");
        expect(merged.modelParams).toEqual({
            temperature: 0.1,
            nested: { a: 1 },
            arr: [1, 2],
            x: 1
        });
        expect(merged.providerParams).toEqual({ region: "us" });
        expect(merged.generalParams).toEqual({ timeoutMs: 1000 });
    });
});
