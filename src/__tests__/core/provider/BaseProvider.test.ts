import { describe, it, expect, beforeEach } from 'vitest';
import { AIProvider } from '#root/core/provider/Provider.js';

// Tests for BaseProvider behavior: initialization, capability registration,
// and getMergedOptions deep-merge/model resolution behavior.
describe('BaseProvider', () => {
    it('constructor sets providerType', async () => {
        const mod = await import('#root/core/provider/BaseProvider.js');
        const { AIProvider } = await import('#root/core/provider/Provider.js');
        const BaseProvider = mod.BaseProvider;
        class P extends BaseProvider { constructor() { super(AIProvider.OpenAI); } }
        const p = new P();
        expect(p.providerType).toBe(AIProvider.OpenAI);
    });

    it('getProviderType returns correct type', async () => {
        const mod = await import('#root/core/provider/BaseProvider.js');
        const { AIProvider } = await import('#root/core/provider/Provider.js');
        const BaseProvider = mod.BaseProvider;
        class P extends BaseProvider { constructor() { super(AIProvider.OpenAI); } }
        const p = new P();
        expect(p.getProviderType()).toBe(AIProvider.OpenAI);
    });

    it('mergeOptions handles primitives, arrays, objects, and skips falsy', async () => {
        const mod = await import('#root/core/provider/BaseProvider.js');
        const { AIProvider } = await import('#root/core/provider/Provider.js');
        const BaseProvider = mod.BaseProvider;
        class P extends BaseProvider { constructor() { super(AIProvider.OpenAI); } public callMerge(...args: any[]) { return this.mergeOptions(...args); } }
        const p = new P();
        const merged = p.callMerge(
            { a: 1, b: [1, 2], c: { d: 2 } },
            { a: 2, b: [3], c: { e: 3 } },
            null,
            undefined
        );
        expect(merged.a).toBe(2);
        expect(merged.b).toEqual([3]);
        expect(merged.c).toEqual({ d: 2, e: 3 });
    });

    it('getMergedOptions throws if not initialized', async () => {
        const mod = await import('#root/core/provider/BaseProvider.js');
        const { AIProvider } = await import('#root/core/provider/Provider.js');
        const BaseProvider = mod.BaseProvider;
        class P extends BaseProvider { constructor() { super(AIProvider.OpenAI); } }
        const p = new P();
        expect(() => p.getMergedOptions('foo')).toThrow('openai provider not initialized');
    });

    it('getMergedOptions throws if model cannot be resolved', async () => {
        const mod = await import('#root/core/provider/BaseProvider.js');
        const { AIProvider } = await import('#root/core/provider/Provider.js');
        const BaseProvider = mod.BaseProvider;
        class P extends BaseProvider { constructor() { super(AIProvider.OpenAI); } async init(cfg: any) { this.config = cfg; } }
        const p = new P();
        p.init({ type: AIProvider.OpenAI, defaultModels: {}, models: {} });
        expect(() => p.getMergedOptions('foo')).toThrow("Unable to resolve model for capability='foo'");
    });

    it('init() throws in BaseProvider', async () => {
        const mod = await import('#root/core/provider/BaseProvider.js');
        const { AIProvider } = await import('#root/core/provider/Provider.js');
        const BaseProvider = mod.BaseProvider;
        class MinimalProvider extends BaseProvider {
            constructor() { super(AIProvider.OpenAI); }
            // Do not override init
        }
        const p = new MinimalProvider();
        expect(() => p.init({ type: AIProvider.OpenAI, defaultModels: {}, models: {} })).toThrow('init() Not implemented');
    });
    let BaseProvider: any;

    beforeEach(async () => {
        // reset modules to ensure fresh class instance
        await import('vitest');
        const mod = await import('#root/core/provider/BaseProvider.js');
        BaseProvider = mod.BaseProvider;
    });

    it('isInitialized returns false before init and true after config set', () => {
        class P extends BaseProvider { constructor() { super(AIProvider.OpenAI); } }
        const p = new P();
        expect(p.isInitialized()).toBe(false);
        // simulate initialization by setting protected config
        p.config = { type: AIProvider.OpenAI, defaultModels: {}, models: {} };
        expect(p.isInitialized()).toBe(true);
    });

    it('ensureInitialized throws when not initialized', () => {
        class P extends BaseProvider { constructor() { super(AIProvider.OpenAI); } }
        const p = new P();
        expect(() => p.ensureInitialized()).toThrow();
    });

    it('registerCapability and hasCapability work', () => {
        class P extends BaseProvider {
            constructor() { super(AIProvider.OpenAI); }
            async init(_cfg: any) { this.config = { type: AIProvider.OpenAI, defaultModels: {}, models: {} }; }
            // helper to expose protected registerCapability
            public exposeRegister(key: any, impl: any) { this.registerCapability(key as any, impl); }
        }

        const p = new P();
        p.exposeRegister('foo' as any, { hello: 'world' } as any);
        expect(p.hasCapability('foo' as any)).toBe(true);
    });

    it('getMergedOptions resolves model and deep-merges options', () => {
        class P extends BaseProvider {
            constructor() { super(AIProvider.OpenAI); }
            async init(cfg: any) { this.config = cfg; }
        }

        const p = new P();

        // provider-level defaults
        const cfg: any = {
            defaultModel: 'm1',
            providerDefaults: {
                modelParams: { nested: { a: 1, b: 2 }, arr: [1, 2] },
                providerParams: { p: 1 },
                generalParams: { g: 1 }
            },
            models: {
                m1: {
                    cap: {
                        modelParams: { nested: { b: 3, c: 4 }, extra: 5 },
                        providerParams: { p: 2 },
                        generalParams: { g: 2 }
                    }
                }
            }
        };

        // initialize provider with cfg
        p.config = cfg;

        const merged = p.getMergedOptions('cap');
        // model should be resolved to defaultModel
        expect(merged.model).toBe('m1');

        // nested merge: a preserved from providerDefaults, b overridden by model config, c from model
        expect(merged.modelParams.nested.a).toBe(1);
        expect(merged.modelParams.nested.b).toBe(3);
        expect(merged.modelParams.nested.c).toBe(4);

        // arrays override: model config didn't supply arr, so providerDefaults arr should remain
        expect(Array.isArray(merged.modelParams.arr)).toBe(true);
        expect(merged.modelParams.arr[0]).toBe(1);

        // providerParams and generalParams merged/overridden
        expect(merged.providerParams.p).toBe(2);
        expect(merged.generalParams.g).toBe(2);
    });

    it('getMergedOptions respects runtime overrides and throws when model missing', () => {
        class P extends BaseProvider { constructor() { super(AIProvider.OpenAI); } async init(cfg: any) { this.config = cfg; } }
        const p = new P();

        const cfg: any = {
            providerDefaults: { modelParams: { a: 1 } },
            models: {}
        };

        p.config = cfg;

        // runtime overrides can specify a model that isn't present => still used if provided
        const runtime = { model: 'x', modelParams: { b: 2 } };
        // since model 'x' isn't defined in models, getMergedOptions will still return with model 'x'
        const merged = p.getMergedOptions('anycap', runtime as any);
        expect(merged.model).toBe('x');
        expect(merged.modelParams.b).toBe(2);

        // If no model can be determined, throw
        p.config = { type: AIProvider.OpenAI, providerDefaults: {}, models: {}, defaultModel: undefined, defaultModels: {} } as any;
        expect(() => p.getMergedOptions('cap', {})).toThrow();
    });
});
