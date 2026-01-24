import { describe, it, expect } from 'vitest';
import { CapabilityUnsupportedError } from '#root/core/types/exceptions/CapabilityUnsupportedError.js';

describe('CapabilityUnsupportedError', () => {
    it('sets name and message', () => {
        const err = new CapabilityUnsupportedError('openai', 'chat');
        expect(err.name).toBe('CapabilityUnsupportedError');
        expect(err.message).toContain('No capability chat found for openai provider');
    });

    it('works with other provider types and keys', () => {
        const err = new CapabilityUnsupportedError('anthropic', 'embed');
        expect(err.message).toContain('No capability embed found for anthropic provider');
    });
});
