import assert from 'node:assert/strict';

class Expectation<T> {
  constructor(private readonly actual: T, private readonly negated = false) {}

  get not(): Expectation<T> {
    return new Expectation(this.actual, !this.negated);
  }

  toBe(expected: unknown): void {
    if (this.negated) {
      assert.notStrictEqual(this.actual, expected);
    } else {
      assert.strictEqual(this.actual, expected);
    }
  }

  toBeLessThan(expected: number): void {
    const passed = (this.actual as unknown as number) < expected;
    if (this.negated ? passed : !passed) {
      assert.fail(`Expected ${this.actual}${this.negated ? ' not' : ''} to be less than ${expected}`);
    }
  }

  toBeNull(): void {
    if (this.negated) {
      assert.notStrictEqual(this.actual, null);
    } else {
      assert.strictEqual(this.actual, null);
    }
  }

  toThrow(expected?: new (...args: any[]) => Error): void {
    if (typeof this.actual !== 'function') {
      assert.fail('toThrow requires a function');
    }
    let thrown: unknown;
    try {
      (this.actual as () => unknown)();
    } catch (err) {
      thrown = err;
    }
    if (this.negated) {
      if (thrown !== undefined) {
        assert.fail(`Expected function not to throw, but it threw ${String(thrown)}`);
      }
      return;
    }
    if (thrown === undefined) {
      assert.fail('Expected function to throw, but it did not');
    }
    if (expected && !(thrown instanceof expected)) {
      assert.fail(`Expected thrown error to be instance of ${expected.name}, got ${String(thrown)}`);
    }
  }
}

export function expect<T>(actual: T): Expectation<T> {
  return new Expectation(actual);
}
