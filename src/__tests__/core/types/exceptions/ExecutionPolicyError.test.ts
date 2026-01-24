import { describe, it, expect } from 'vitest';
import { ExecutionPolicyError } from '#root/core/types/exceptions/ExecutionPolicyError.js';

describe('ExecutionPolicyError', () => {
    it('sets name and message', () => {
        const err = new ExecutionPolicyError('bad policy');
        expect(err.name).toBe('ExecutionPolicyError');
        expect(err.message).toBe('bad policy');
    });

    it('handles empty message', () => {
        const err = new ExecutionPolicyError('');
        expect(err.message).toBe('');
    });
});
