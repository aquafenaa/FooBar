import { spawn } from 'node:child_process';

// name of the docker container the model's commands run in (see docker-compose.yml). unset means no sandbox, e.g. when developing locally
const { SANDBOX_CONTAINER } = process.env;

const MAX_OUTPUT_LENGTH = 4000; // characters of stdout and stderr each, kept from the end, since errors and results are usually last
const MAX_NOTES_LENGTH = 4000; // characters of NOTES.md put in the prompt each reply
const DEFAULT_TIMEOUT = 30; // seconds
const MAX_TIMEOUT = 120;

type SandboxResult = { exit_code: number, stdout: string, stderr: string, timed_out: boolean, truncated: boolean };

function isSandboxEnabled(): boolean {
  return !!SANDBOX_CONTAINER;
}

/**
 * Runs a bash command in the sandbox's /workspace, optionally piping `stdin` into it, with `env` as variables.
 * One workspace, shared by every attached server, like the main memories.
 * Arguments go straight to docker, never through a host shell, so the command is only ever interpreted by bash inside the container
 */
function sandboxExec(command: string, options: { stdin?: string, env?: Record<string, string>, timeout?: number } = {}): Promise<SandboxResult> {
  const timeout = Math.min(Math.max(options.timeout ?? DEFAULT_TIMEOUT, 1), MAX_TIMEOUT);

  return new Promise((resolve, reject) => {
    // timeout runs inside the container, since killing `docker exec` here wouldn't stop the command there. -k kills it if it ignores SIGTERM
    const child = spawn('docker', [
      'exec', '-i', ...Object.entries(options.env ?? {}).flatMap(([key, value]) => ['-e', `${key}=${value}`]), SANDBOX_CONTAINER!,
      'timeout', '-k', '5', String(timeout),
      'bash', '-c', command,
    ]);

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout = (stdout + chunk).slice(-MAX_OUTPUT_LENGTH * 2); }); // keep memory bounded on huge output
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-MAX_OUTPUT_LENGTH * 2); });

    // in case docker itself hangs. well past the in-container timeout, so that one normally fires first
    const killTimer = setTimeout(() => child.kill('SIGKILL'), (timeout + 15) * 1000);

    child.on('error', (error) => { clearTimeout(killTimer); reject(error); }); // e.g. docker isn't installed
    child.on('close', (code) => {
      clearTimeout(killTimer);
      const exitCode = code ?? 137;
      resolve({
        exit_code: exitCode,
        stdout: stdout.slice(-MAX_OUTPUT_LENGTH),
        stderr: stderr.slice(-MAX_OUTPUT_LENGTH),
        timed_out: exitCode === 124 || exitCode === 137, // what timeout exits with after SIGTERM and SIGKILL
        truncated: stdout.length > MAX_OUTPUT_LENGTH || stderr.length > MAX_OUTPUT_LENGTH,
      });
    });

    child.stdin.end(options.stdin ?? '');
  });
}

// NOTES.md, which the model keeps so it can pick up where it left off. empty if there's no sandbox or no notes yet
async function readNotes(): Promise<string> {
  if (!isSandboxEnabled()) return '';

  try {
    const result = await sandboxExec('cat NOTES.md 2>/dev/null', { timeout: 5 });
    if (result.exit_code !== 0) return '';
    return result.stdout.length > MAX_NOTES_LENGTH ? `${result.stdout.substring(0, MAX_NOTES_LENGTH)}\n[cut off]` : result.stdout;
  } catch (error) {
    console.error(error);
    return '';
  }
}

export { isSandboxEnabled, sandboxExec, readNotes, MAX_TIMEOUT };
