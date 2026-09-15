// Replays the hook commands declared in .claude/settings.json through the platform shell --
// exactly how the hook runner executes them -- and asserts the emit/silence boundary.
//
// This is the guard for the bug class that motivated it. The two graphify hooks were inline
// bash one-liners wrapping `python3`, and the SessionStart hook was `bash "$CLAUDE_PROJECT_DIR/
// .../session-start.sh"`. Measured 2026-09-15: every one of them exited 127 with zero output
// from both cmd.exe and WSL bash, so the "query the graph before exploring" rule and the
// session-start environment check were documented everywhere and enforced nowhere. Nothing
// tested them -- the other three hooks had vitest suites, this pair had none. A hook that cannot
// run exits 0 and prints nothing, which is indistinguishable from a hook that passed.
//
// Kept as a vitest suite (not a standalone script) for the same reason verify-gate's tests are:
// the DoD gate runs `npx vitest run`, so this cannot rot into "someone remembers to run it".
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const GRAPH_PATH = 'graphify-out/graph.json';
const graphExists = existsSync(GRAPH_PATH); // gitignored: absent on a fresh clone / in CI
const settings = JSON.parse(readFileSync('.claude/settings.json', 'utf8'));

/** Run one hook command string the way the runner does: JSON on stdin, platform shell. */
function replay(command, payload) {
  try {
    const stdout = execFileSync(command, {
      input: JSON.stringify(payload),
      encoding: 'utf8',
      shell: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { status: 0, stdout, stderr: '' };
  } catch (err) {
    return { status: err.status ?? 1, stdout: String(err.stdout ?? ''), stderr: String(err.stderr ?? '') };
  }
}

const preToolUse = (matcher) => settings.hooks.PreToolUse.find((h) => h.matcher === matcher);

describe('settings.json / hook wiring', () => {
  it('declares every hook as a node module, not a shell one-liner', () => {
    const commands = Object.values(settings.hooks).flatMap((entries) =>
      entries.flatMap((entry) => entry.hooks.map((h) => h.command))
    );
    expect(commands.length).toBeGreaterThanOrEqual(4);
    for (const command of commands) {
      // A shell one-liner here is how both real defects started: `$(...)`/`case`-based command
      // strings hit cmd.exe, WSL bash and POSIX bash with different quoting rules, and the
      // failure is silent. Add a `.mjs` hook and unit-test it instead.
      expect(command, `hook command is not a node module: ${command}`).toMatch(/^node \.claude\/hooks\/[\w.-]+\.mjs$/);
    }
  });
});

describe('settings.json / graphify PreToolUse hooks actually fire', () => {
  it('exits 0 for every simulated tool call', () => {
    const probes = [
      [preToolUse('Read|Glob'), { tool_name: 'Read', tool_input: { file_path: 'src/server/queues.ts' } }],
      [preToolUse('Read|Glob'), { tool_name: 'Read', tool_input: { file_path: GRAPH_PATH } }],
      [preToolUse('Bash'), { tool_name: 'Bash', tool_input: { command: 'grep -rn "drift" src/server/' } }],
      [preToolUse('Bash'), { tool_name: 'Bash', tool_input: { command: 'git status --short' } }],
    ];
    for (const [entry, payload] of probes) {
      for (const hook of entry.hooks) {
        const { status, stderr } = replay(hook.command, payload);
        expect(status, `${hook.command} exited ${status}: ${stderr}`).toBe(0);
      }
    }
  });

  it('emits the query-the-graph reminder for source reads and raw searches', () => {
    // Without a local graph the hook is correct to stay silent -- assert that instead, so this
    // suite is green on a fresh clone and in CI rather than failing on a gitignored artifact.
    const expected = graphExists ? 'fired' : 'silent';
    const sourceRead = replay(preToolUse('Read|Glob').hooks[0].command, {
      tool_name: 'Read',
      tool_input: { file_path: 'src/server/queues.ts' },
    });
    const rawSearch = replay(preToolUse('Bash').hooks[0].command, {
      tool_name: 'Bash',
      tool_input: { command: 'grep -rn "drift" src/server/' },
    });
    expect(sourceRead.stdout.trim() ? 'fired' : 'silent').toBe(expected);
    expect(rawSearch.stdout.trim() ? 'fired' : 'silent').toBe(expected);
    if (graphExists) {
      expect(sourceRead.stdout).toContain('graphify');
      expect(rawSearch.stdout).toContain('graphify');
    }
  });

  it('stays silent for unrelated reads and commands', () => {
    const graphRead = replay(preToolUse('Read|Glob').hooks[0].command, {
      tool_name: 'Read',
      tool_input: { file_path: GRAPH_PATH },
    });
    const unrelated = replay(preToolUse('Bash').hooks[0].command, {
      tool_name: 'Bash',
      tool_input: { command: 'git status --short' },
    });
    expect(graphRead.stdout.trim()).toBe('');
    expect(unrelated.stdout.trim()).toBe('');
  });
});