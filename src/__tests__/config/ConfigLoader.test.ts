import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { loadDefaultConfig, disabled } from '../testUtils.js';


describe('ConfigLoader - error and env cases', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
        // clean any test env keys we use
        delete process.env.MY_KEY;
        delete process.env.MISSING_KEY;

        process.env.OPENAI_API_KEY_1 = "openai-test-key";
        process.env.ANTHROPIC_API_KEY_1 = "anthropic-test-key";
        process.env.OPENAI_API_KEY_2 = "openai-test-key-2";
        process.env.ANTHROPIC_API_KEY_2 = "anthropic-test-key-2";        
        process.env.GEMINI_API_KEY_1 = "gemini-test-key";
    });

    afterEach(() => {
        try { vi.unmock('config'); } catch {}
        try { vi.unmock('dotenv'); } catch {}
        vi.resetModules();
        vi.clearAllMocks();
        delete process.env.OPENAI_API_KEY_1;
        delete process.env.ANTHROPIC_API_KEY_1;
    });

    it("loads default config and injects API keys from env when missing", async () => {
        const defaultCfg = loadDefaultConfig();
        await vi.doMock('config', () => ({
            default: {
                has: (key: string) => key === "providerplane",
                get: (key: string) => key === "providerplane" ? defaultCfg.providerplane : undefined
            }
        }));
        await vi.doMock('dotenv', () => ({ default: { config: () => {} } }));

        process.env.OPENAI_API_KEY_1 = "openai-test-key";
        process.env.ANTHROPIC_API_KEY_1 = "anthropic-test-key";
        process.env.OPENAI_API_KEY_2 = "openai-test-key-2";
        process.env.ANTHROPIC_API_KEY_2 = "anthropic-test-key-2";        
        process.env.GEMINI_API_KEY_1 = "gemini-test-key";

        const { loadAppConfig } = await import('../../core/config/ConfigLoader.js');
        const cfg = loadAppConfig();

        expect(cfg).toBeDefined();
        expect(typeof cfg.providers).toBe("object");
        expect(cfg.providers.openai).toBeDefined();
        expect(cfg.providers.anthropic).toBeDefined();

        // env injection (apiKey is injected under the connection name, e.g. `default`)
        expect(cfg.providers.openai.default.apiKey).toBe("openai-test-key");
        expect(cfg.providers.anthropic.default.apiKey).toBe("anthropic-test-key");
    }, 15000);

    it("ensures providers have models", async () => {
        const defaultCfg = loadDefaultConfig();
        await vi.doMock('config', () => ({
            default: {
                has: (key: string) => key === "providerplane",
                get: (key: string) => key === "providerplane" ? defaultCfg.providerplane : undefined
            }
        }));
        await vi.doMock('dotenv', () => ({ default: { config: () => {} } }));

        const { loadAppConfig } = await import('../../core/config/ConfigLoader.js');
        const cfg = loadAppConfig();
        expect(Object.keys(cfg.providers.openai.default.models).length).toBeGreaterThan(0);
    });

    it('throws when no providers defined', async () => {
        await vi.doMock('config', () => ({
            default: {
                has: () => false,
                get: () => undefined
            }
        }));

        await vi.doMock('dotenv', () => ({ default: { config: () => { } } }));

        // ensure env vars do not satisfy apiKey checks
        delete process.env.OPENAI_API_KEY_1;
        delete process.env.ANTHROPIC_API_KEY_1;

        const { loadAppConfig } = await import('../../core/config/ConfigLoader.js');

        expect(() => loadAppConfig()).toThrow('At least one provider must be defined in config');
    });

    it("throws when connection missing apiKeyEnvVar", async () => {
        await vi.doMock('config', () => ({
            default: {
                has: (key: string) => key === "providerplane",
                get: (key: string) => key === "providerplane" ? { providers: { openai: { default: {} } } } : undefined
            }
        }));

        await vi.doMock('dotenv', () => ({ default: { config: () => { } } }));

        const { loadAppConfig } = await import('../../core/config/ConfigLoader.js');

        expect(() => loadAppConfig()).toThrow("missing 'apiKeyEnvVar'");
    });

    it('throws when api key env var not set', async () => {
        await vi.doMock('config', () => ({
            default: {
                has: (key: string) => key === "providerplane",
                get: (key: string) => key === "providerplane"
                    ? { providers: { openai: { default: { apiKeyEnvVar: 'MISSING_KEY' } } } }
                    : undefined
            }
        }));

        await vi.doMock('dotenv', () => ({ default: { config: () => { } } }));

        const { loadAppConfig } = await import('../../core/config/ConfigLoader.js');

        delete process.env.MISSING_KEY;
        expect(() => loadAppConfig()).toThrow("Environment variable 'MISSING_KEY' not set");
    });

    it('injects apiKey from env for mocked config', async () => {
        const mockCfg = { appConfig: { foo: 'bar' }, providers: { openai: { default: { apiKeyEnvVar: 'MY_KEY', other: 'x', defaultModels: {}, models: {} } } } };
        await vi.doMock('config', () => ({
            default: {
                has: (key: string) => key === "providerplane",
                get: (key: string) => key === "providerplane" ? mockCfg : undefined
            }
        }));

        await vi.doMock('dotenv', () => ({ default: { config: () => { } } }));

        process.env.MY_KEY = 'secret';

        const { loadAppConfig } = await import('../../core/config/ConfigLoader.js');

        const cfg = loadAppConfig();
        expect(cfg).toBeDefined();
        expect(cfg.appConfig).toBeDefined();
        expect(cfg.providers).toBeDefined();
        expect(cfg.providers.openai).toBeDefined();
        expect(cfg.providers.openai.default.apiKey).toBe('secret');
    });
});
