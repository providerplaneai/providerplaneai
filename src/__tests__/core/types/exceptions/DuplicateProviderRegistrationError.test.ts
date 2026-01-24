import { describe, it, expect } from 'vitest';
import { DuplicateProviderRegistrationError } from '#root/core/types/exceptions/DuplicateProviderRegistrationError.js';

describe('DuplicateProviderRegistrationError', () => {
    it('sets name and message', () => {
        const err = new DuplicateProviderRegistrationError('openai', 'default');
        expect(err.name).toBe('DuplicateProviderRegistrationError');
        expect(err.message).toContain('Provider already registered for openai with name');
    });

    it('works with other provider types and names', () => {
        const err = new DuplicateProviderRegistrationError('anthropic', 'prod');
        expect(err.message).toContain('anthropic');
        expect(err.message).toContain('prod');
    });
});
