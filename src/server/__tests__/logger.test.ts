import { describe, it, expect, vi, afterEach } from "vitest";
import { installStructuredConsole } from "../logger";

// Every test here MUST call the returned restore function (or use the `withStructuredConsole`
// helper below) -- this repo's vitest config runs the whole suite in a single shared process
// (`pool: 'forks', poolOptions: { forks: { singleFork: true } }`), so an un-restored console
// patch would leak into every test file that runs after this one in the same run, silently
// rerouting their console output (and any console.log-based assertions) through a mock.
describe("installStructuredConsole", () => {
  function fakeTarget() {
    return {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("routes console.log through target.info", () => {
    const target = fakeTarget();
    const restore = installStructuredConsole(target);
    try {
      console.log("hello", 42);
      expect(target.info).toHaveBeenCalledWith("hello 42");
    } finally {
      restore();
    }
  });

  it("routes console.error through target.error", () => {
    const target = fakeTarget();
    const restore = installStructuredConsole(target);
    try {
      console.error("boom");
      expect(target.error).toHaveBeenCalledWith("boom");
    } finally {
      restore();
    }
  });

  it("routes console.warn through target.warn", () => {
    const target = fakeTarget();
    const restore = installStructuredConsole(target);
    try {
      console.warn("careful");
      expect(target.warn).toHaveBeenCalledWith("careful");
    } finally {
      restore();
    }
  });

  it("routes console.debug through target.debug", () => {
    const target = fakeTarget();
    const restore = installStructuredConsole(target);
    try {
      console.debug("trace me");
      expect(target.debug).toHaveBeenCalledWith("trace me");
    } finally {
      restore();
    }
  });

  it("suppresses the cosmetic ioredis ACL-mismatch warning instead of forwarding it", () => {
    const target = fakeTarget();
    const restore = installStructuredConsole(target);
    try {
      console.warn("WARNING: Redis 7 does not require a password to be set for AUTH");
      expect(target.warn).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });

  it("still forwards a warning that merely happens to contain other text", () => {
    const target = fakeTarget();
    const restore = installStructuredConsole(target);
    try {
      console.warn("a real problem unrelated to ioredis");
      expect(target.warn).toHaveBeenCalledWith("a real problem unrelated to ioredis");
    } finally {
      restore();
    }
  });

  it("restore() puts back the exact original console methods", () => {
    const originalLog = console.log;
    const originalWarn = console.warn;
    const originalError = console.error;
    const restore = installStructuredConsole(fakeTarget());
    expect(console.log).not.toBe(originalLog);
    restore();
    expect(console.log).toBe(originalLog);
    expect(console.warn).toBe(originalWarn);
    expect(console.error).toBe(originalError);
  });

  it("flattens multi-argument calls the same way console.log itself would", () => {
    const target = fakeTarget();
    const restore = installStructuredConsole(target);
    try {
      console.log("Job %s finished in %dms", "stock-scoring", 1234);
      expect(target.info).toHaveBeenCalledWith("Job stock-scoring finished in 1234ms");
    } finally {
      restore();
    }
  });

  it("does not throw or recurse when the default (real winston) target is used", () => {
    // No fake target passed -- exercises the real default parameter path once, restored
    // immediately so it can't affect any other test in this shared-process run.
    const restore = installStructuredConsole();
    try {
      expect(() => console.log("smoke test against the real logger")).not.toThrow();
    } finally {
      restore();
    }
  });
});
