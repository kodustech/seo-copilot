/**
 * The agent's "hands" for code execution — Phase C. The brain (agent loop)
 * only ever calls `executor.run(...)`; where that runs is behind this seam,
 * so swapping Modal for another sandbox is an adapter change, never a rewrite.
 *
 * ⚠️ Untrusted code runs here (cloned repos, benchmarks). It must be an
 * isolated, disposable sandbox — never the app/prod box — and the persona's
 * API key must NEVER be injected into it or reachable by a command.
 */

export type ExecResult = {
  stdout: string;
  stderr: string;
  exit_code: number;
};

export interface Executor {
  /** Run a shell command in a fresh, isolated sandbox and return its output. */
  run(command: string, opts?: { timeout_ms?: number }): Promise<ExecResult>;
}

/**
 * Modal adapter — a fresh, disposable Modal Sandbox per run (native JS SDK, no
 * Python). The command runs in the sandbox (never on the app box); the sandbox
 * is created with NO secrets, so the Modal token and every persona key stay out
 * of reach of the untrusted command. The sandbox is terminated afterwards.
 *
 * Auth via MODAL_TOKEN_ID / MODAL_TOKEN_SECRET (read from env by ModalClient).
 * Cheapest option: Modal's free tier grants $30/mo of compute and scales to zero.
 */
function modalExecutor(): Executor {
  return {
    async run(command, opts): Promise<ExecResult> {
      const { ModalClient } = await import("modal");
      const modal = new ModalClient(); // MODAL_TOKEN_ID / MODAL_TOKEN_SECRET from env
      const app = await modal.apps.fromName("persona-sandbox", { createIfMissing: true });
      const image = modal.images.fromRegistry(
        process.env.MODAL_SANDBOX_IMAGE || "python:3.13-slim",
      );
      const sandbox = await modal.sandboxes.create(app, image, {
        timeoutMs: 120_000, // sandbox lifetime cap
      });
      try {
        const proc = await sandbox.exec(["bash", "-c", command], {
          mode: "text",
          timeoutMs: opts?.timeout_ms ?? 60_000,
        });
        // Drain stdout/stderr while waiting for exit — reading concurrently with
        // wait() avoids a full-pipe deadlock on large output.
        const [stdout, stderr, exit_code] = await Promise.all([
          proc.stdout.readText(),
          proc.stderr.readText(),
          proc.wait(),
        ]);
        return { stdout, stderr, exit_code };
      } finally {
        await sandbox.terminate().catch(() => {});
      }
    },
  };
}

/**
 * E2B adapter — a fresh, isolated, disposable cloud sandbox per run. The command
 * runs there (never on the app box), and the sandbox is killed afterwards. No
 * persona secret is ever passed in — only the command string.
 */
function e2bExecutor(): Executor {
  return {
    async run(command, opts): Promise<ExecResult> {
      const { Sandbox, CommandExitError } = await import("e2b");
      const sandbox = await Sandbox.create({
        apiKey: process.env.E2B_API_KEY,
        timeoutMs: 120_000, // sandbox lifetime
      });
      try {
        const r = await sandbox.commands.run(command, {
          timeoutMs: opts?.timeout_ms ?? 60_000,
        });
        return { stdout: r.stdout, stderr: r.stderr, exit_code: r.exitCode };
      } catch (err) {
        // A non-zero exit throws CommandExitError — surface it as a result, not
        // a tool failure, so the agent sees stderr and the exit code.
        if (err instanceof CommandExitError) {
          return { stdout: err.stdout, stderr: err.stderr, exit_code: err.exitCode };
        }
        throw err;
      } finally {
        await sandbox.kill().catch(() => {});
      }
    },
  };
}

/**
 * Returns the configured executor, or null when code execution is not set up.
 * Tools treat null as "code execution unavailable" and tell the agent so —
 * nothing dangerous can run until an executor exists.
 */
export function getExecutor(): Executor | null {
  // Modal preferred (cheapest — free $30/mo, scales to zero); E2B as a fallback.
  if (process.env.MODAL_TOKEN_ID && process.env.MODAL_TOKEN_SECRET) {
    return modalExecutor();
  }
  if (process.env.E2B_API_KEY) {
    return e2bExecutor();
  }
  return null;
}
