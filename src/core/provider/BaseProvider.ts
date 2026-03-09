/**
 * @module core/provider/BaseProvider.ts
 * @description ProviderPlaneAI source module.
 */
import {
    AIProviderType,
    BuiltInCapabilityKey,
    CapabilityConfig,
    CapabilityExecutor,
    CapabilityKeyType,
    CapabilityMap,
    CapabilityUnsupportedError,
    CustomCapabilityKey,
    ProviderCapability,
    ProviderConnectionConfig
} from "#root/index.js";

/**
 * Abstract base class for all AI providers.
 *
 * Provides shared helpers and state management for provider implementations.
 *
 * Responsibilities:
 * - Store and manage provider configuration
 * - Register and check supported capabilities
 * - Merge provider defaults, model configs, and runtime options
 * - Offer type-safe capability checks
 *
 * Does not implement Provider directly, but is intended for extension.
 */
export abstract class BaseProvider {
    /**
     * Type of this provider (OpenAI, Anthropic, Gemini, etc.)
     */
    readonly providerType: AIProviderType;
    /**
     * Current connection config
     */
    protected config: ProviderConnectionConfig | null = null;
    /**
     * Support provider capabilities
     */
    protected capabilities: Partial<CapabilityMap> = {};

    protected executors?: Map<CapabilityKeyType, CapabilityExecutor<any, any, any>>;

    /**
     * Base constructor.
     * @param providerType Type of the provider, used for registration and logging
     */
    public constructor(providerType: AIProviderType) {
        this.providerType = providerType;
    }

    /**
     * Initialize the provider with a connection configuration.
     * Must be implemented by concrete providers.
     *
     * @param _config Connection configuration
     * @throws Error if not implemented
     */
    init(_config: ProviderConnectionConfig) {
        throw new Error("init() Not implemented");
    }

    /**
     * Check if the provider has been initialized.
     *
     * @returns True if initialized, false otherwise
     */
    public isInitialized(): boolean {
        return this.config !== null;
    }

    public getProviderType(): AIProviderType {
        return this.providerType;
    }

    public getCapabilities(): Partial<CapabilityMap> {
        return this.capabilities;
    }

    private resolveCapability<C extends CapabilityKeyType>(
        capability: C
    ): C extends keyof CapabilityMap ? CapabilityMap[C] : ProviderCapability {
        const capabilities = this.capabilities as Record<string, ProviderCapability | undefined>;
        if (capabilities[capability]) {
            return capabilities[capability] as C extends keyof CapabilityMap ? CapabilityMap[C] : ProviderCapability;
        }

        if (this.executors?.has(capability)) {
            // Client-registered executors may be used for custom capabilities and are resolved
            // through this fallback path by design.
            return this.executors.get(capability) as unknown as C extends keyof CapabilityMap
                ? CapabilityMap[C]
                : ProviderCapability;
        }

        throw new CapabilityUnsupportedError(this.providerType, capability);
    }

    public getCapability<C extends CapabilityKeyType>(
        capability: C
    ): C extends keyof CapabilityMap ? CapabilityMap[C] : ProviderCapability {
        return this.resolveCapability(capability);
    }

    /**
     * Type-safe runtime check for a capability.
     * Allows safe casting after confirming the capability is registered.
     *
     * @template C Capability key
     * @param capability Capability symbol
     * @returns True if the capability is registered
     */
    public hasCapability<C extends CapabilityKeyType>(capability: C): boolean {
        const capabilities = this.capabilities as Record<string, ProviderCapability | undefined>;
        return !!capabilities[capability] || !!this.executors?.has(capability);
    }

    /**
     * Register a capability implementation.
     * Called by concrete providers to declare support for a capability.
     *
     * @template C Capability key
     * @param capability Capability symbol
     * @param impl Implementation of the capability
     */
    protected registerCapability<C extends BuiltInCapabilityKey>(capability: C, impl: CapabilityMap[C]): void;
    protected registerCapability(capability: CustomCapabilityKey, impl: ProviderCapability): void;
    protected registerCapability(capability: CapabilityKeyType, impl: ProviderCapability) {
        const capabilities = this.capabilities as Record<string, ProviderCapability | undefined>;
        capabilities[capability] = impl;
    }

    public setClientExecutors(executors: Map<CapabilityKeyType, CapabilityExecutor<any, any, any>>) {
        this.executors = executors;
    }

    /**
     * Deep-merge multiple objects.
     * Arrays override completely, objects are recursively merged, primitives override.
     * Used for merging provider defaults, model configurations, and runtime options.
     *
     * @param sources Objects to merge
     * @returns Deep-merged object
     */
    protected mergeOptions(...sources: any[]): any {
        const result: any = {};

        for (const src of sources) {
            if (!src) {
                continue;
            }
            this.mergeOptionsInto(result, src);
        }

        return result;
    }

    /**
     * Merges a source object into a target object.
     * Arrays override, plain objects are deep-merged, primitives override.
     *
     * @param target Target object to mutate
     * @param source Source object to read from
     */
    private mergeOptionsInto(target: Record<string, unknown>, source: Record<string, unknown>) {
        const stack: Array<{ dst: Record<string, unknown>; src: Record<string, unknown> }> = [{ dst: target, src: source }];

        while (stack.length > 0) {
            const frame = stack.pop()!;
            const { dst, src } = frame;

            for (const [key, value] of Object.entries(src)) {
                if (Array.isArray(value)) {
                    dst[key] = [...value];
                    continue;
                }

                if (this.isMergeableObject(value)) {
                    const current = dst[key];
                    if (!this.isMergeableObject(current)) {
                        dst[key] = {};
                    }
                    stack.push({
                        dst: dst[key] as Record<string, unknown>,
                        src: value as Record<string, unknown>
                    });
                    continue;
                }

                dst[key] = value;
            }
        }
    }

    /**
     * Determines whether a value is a plain object that should be deep-merged.
     *
     * @param value Candidate value
     * @returns `true` for mergeable plain objects
     */
    private isMergeableObject(value: unknown): value is Record<string, unknown> {
        if (!value || typeof value !== "object" || Array.isArray(value)) {
            return false;
        }
        const prototype = Object.getPrototypeOf(value);
        return prototype === Object.prototype || prototype === null;
    }

    /**
     * Resolve and merge configuration for a capability.
     *
     * Merge precedence (low → high):
     * 1. providerDefaults (global provider-level defaults)
     * 2. model capability defaults (models[modelName][capability])
     * 3. runtimeOptions (request-level overrides)
     *
     * Model resolution fallback:
     * runtimeOptions.model → config.defaultModels[capability] → config.defaultModel
     *
     * @param capability Name of the capability
     * @param runtimeOptions Request-level override options
     * @throws Error if a model cannot be resolved for this capability
     * @returns Merged configuration with keys: model, modelParams, providerParams, generalParams
     */
    public getMergedOptions(capability: string, runtimeOptions: any = {}) {
        this.ensureInitialized();

        // 1) Resolve model
        const resolvedModel =
            runtimeOptions?.model ||
            (this.config!.defaultModels ? this.config!.defaultModels[capability] : undefined) ||
            this.config!.defaultModel;

        if (!resolvedModel) {
            throw new Error(`Unable to resolve model for capability='${capability}'`);
        }

        // 2) Get provider defaults (if any)
        const providerDefaults: CapabilityConfig = {
            modelParams: this.config!.providerDefaults?.modelParams || {},
            providerParams: this.config!.providerDefaults?.providerParams || {},
            generalParams: this.config!.providerDefaults?.generalParams || {}
        };

        // 3) Get model config for the capability
        const capabilityBlock: CapabilityConfig = this.config!.models?.[resolvedModel]?.[capability] || {};

        // If you haven't added providerParams/modelParams in JSON yet, treat all fields as modelParams
        const modelParamsFromConfig = capabilityBlock.modelParams || {};
        const providerParamsFromConfig = capabilityBlock.providerParams || {};
        const generalParamsFromConfig = capabilityBlock.generalParams || {};

        // 4) Runtime overrides
        const runtimeModelParams = runtimeOptions.modelParams || {};
        const runtimeProviderParams = runtimeOptions.providerParams || {};
        const runtimeGeneralParams = runtimeOptions.generalParams || {};

        // 5) Merge provider defaults => model config => runtime
        const mergedModelParams = this.mergeOptions(providerDefaults.modelParams, modelParamsFromConfig, runtimeModelParams);

        const mergedProviderParams = this.mergeOptions(
            providerDefaults.providerParams,
            providerParamsFromConfig,
            runtimeProviderParams
        );

        const mergedGeneralParams = this.mergeOptions(
            providerDefaults.generalParams,
            generalParamsFromConfig,
            runtimeGeneralParams
        );

        // Return a normalized envelope so downstream capability code can rely on
        // a stable options shape regardless of provider-specific config structure.
        return {
            model: resolvedModel,
            modelParams: mergedModelParams,
            providerParams: mergedProviderParams,
            generalParams: mergedGeneralParams
        };
    }

    /**
     * Ensures that the provider has been initialized before use.
     *
     * @throws Error if not initialized
     */
    public ensureInitialized(): void {
        if (!this.config) {
            throw new Error(`${this.providerType} provider not initialized`);
        }
    }
}
