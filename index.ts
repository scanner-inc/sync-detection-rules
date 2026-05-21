import * as core from '@actions/core';
import { execFileSync } from 'child_process';

import type { SyncGitRepoResult } from './gen/sync_git_repo_result';

// Internal representation the rest of this file consumes. Decoupled from
// the wire format (`SyncGitRepoResult`) so an upstream rename or removal
// breaks `toSyncOutput` at compile time, rather than silently propagating
// to the runtime code below.
interface SyncFailure {
  checkStatus: string;
  filePath: string;
  reason: string | undefined;
}

interface SyncWarning {
  filePath: string;
  messages: string[];
}

interface SyncOutput {
  branch: string;
  commitSha: string;
  rulesSynced: number;
  rulesDeleted: number;
  failures: SyncFailure[];
  warnings: SyncWarning[];
}

function toSyncOutput(wire: SyncGitRepoResult): SyncOutput {
  return {
    branch: wire.branch,
    commitSha: wire.commit_sha,
    rulesSynced: wire.detection_rules_synced,
    rulesDeleted: wire.detection_rules_deleted,
    failures: (wire.failures ?? []).map((f) => ({
      checkStatus: f.check_status,
      filePath: f.file_path,
      reason: f.reason ?? undefined,
    })),
    warnings: (wire.warnings ?? []).map((w) => ({
      filePath: w.file_path,
      messages: w.messages,
    })),
  };
}

async function run(): Promise<void> {
  try {
    const apiUrl = core.getInput('scanner_api_url', { required: true });
    const apiKey = core.getInput('scanner_api_key', { required: true });
    const pushKey = core.getInput('push_key', { required: true });
    const pathInput = core.getInput('path') || '.';

    process.env.SCANNER_API_URL = apiUrl;
    process.env.SCANNER_API_KEY = apiKey;

    // `execFileSync` (no shell) is what prevents shell-metacharacter
    // injection from `pushKey` / `pathInput` — each arg is passed
    // verbatim to the binary's argv.
    const args = ['sync-git-repo', '--json', '--push-key', pushKey, pathInput];

    core.info(`Running: scanner-cli sync-git-repo --json --push-key *** ${pathInput}`);

    // `--json` guarantees structured stdout on both success and failure (sync
    // failures); the process exits non-zero iff there were sync failures, which
    // makes execFileSync throw with `error.stdout` populated. Pre-flight errors
    // (not a git repo, detached HEAD, missing CLI, etc.) skip the JSON path and
    // surface on stderr — we handle those at the bottom.
    let stdout: string;
    let threw = false;
    try {
      stdout = execFileSync('scanner-cli', args, { encoding: 'utf8' });
    } catch (error: any) {
      threw = true;
      stdout = error.stdout ?? '';
      if (!stdout) {
        // No JSON to parse — fall back to plain failure reporting.
        if (error.stderr) core.info(error.stderr);
        core.setFailed(error.stderr?.trim() || 'scanner-cli sync-git-repo failed');
        return;
      }
    }

    let output: SyncOutput;
    try {
      output = toSyncOutput(JSON.parse(stdout) as SyncGitRepoResult);
    } catch {
      // Got stdout but it wasn't JSON. Echo what we have and fail loudly so
      // the user can diagnose.
      core.info(stdout);
      core.setFailed('scanner-cli sync-git-repo did not emit valid JSON');
      return;
    }

    core.info(`Branch:     ${output.branch}`);
    core.info(`Commit SHA: ${output.commitSha}`);

    for (const warning of output.warnings) {
      for (const message of warning.messages) {
        core.warning(message, { file: warning.filePath });
      }
    }

    for (const failure of output.failures) {
      const message = failure.reason
        ? `[${failure.checkStatus}] ${failure.reason}`
        : `[${failure.checkStatus}]`;
      core.error(message, { file: failure.filePath });
    }

    if (threw || output.failures.length > 0) {
      const n = output.failures.length;
      core.setFailed(
        `Sync aborted server-side; no rules were applied (${n} failure${n === 1 ? '' : 's'}).`
      );
      return;
    }

    core.info(
      `Synced ${output.rulesSynced} rule(s), deleted ${output.rulesDeleted} rule(s)`
    );
  } catch (error: any) {
    core.setFailed(`Action failed: ${error.message}`);
  }
}

run();
