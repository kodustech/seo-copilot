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
 * Modal adapter — ephemeral sandbox per run, scales to zero.
 * Stub until MODAL creds are configured and the Modal client is wired (Phase C).
 */
function modalExecutor(): Executor {
  return {
    async run(): Promise<ExecResult> {
      throw new Error(
        "Modal executor not wired yet (Phase C). Set MODAL_TOKEN_ID / MODAL_TOKEN_SECRET and implement the adapter.",
      );
    },
  };
}

/**
 * Returns the configured executor, or null when code execution is not set up.
 * Tools treat null as "code execution unavailable" and tell the agent so —
 * nothing dangerous can run until an executor exists.
 */
export function getExecutor(): Executor | null {
  if (process.env.MODAL_TOKEN_ID && process.env.MODAL_TOKEN_SECRET) {
    return modalExecutor();
  }
  return null;
}
