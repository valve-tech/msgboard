import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import {
  parseLsTree,
  planQueries,
  type UpstreamPin,
  type UpstreamState,
} from "./drift.js";

const run = promisify(execFile);

/**
 * Git config that sends a GitLab token, carried in the environment only.
 *
 * GitLab refuses anonymous git traffic from GitHub's runner IPs
 * (`throttle_unauthenticated_git_http`), so CI must authenticate. The header
 * rides in GIT_CONFIG_* rather than argv, because a failed execFile repeats its
 * whole command line in the error, and that error reaches the job log. The
 * header is scoped to the remote's origin, so no other host ever sees it.
 */
export const gitAuthEnv = ({
  remote,
  token,
}: {
  remote: string;
  token?: string;
}): Record<string, string> => {
  if (!token) return {};
  const { origin } = new URL(remote);
  const basic = Buffer.from(`oauth2:${token}`).toString("base64");
  return {
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: `http.${origin}/.extraHeader`,
    GIT_CONFIG_VALUE_0: `Authorization: Basic ${basic}`,
  };
};

/**
 * Read the watched objects out of upstream, without downloading the repository.
 *
 * A treeless partial clone (`--depth 1 --filter=blob:none`) transfers no blob
 * contents, so a daily run costs about a second. Any failure here is allowed to
 * throw: the caller turns it into CANNOT CHECK, which is louder than a pass.
 *
 * Set GITLAB_TOKEN (read_repository scope) where anonymous reads are refused.
 */
export const fetchUpstream = async (
  pin: UpstreamPin,
): Promise<UpstreamState> => {
  const dir = await mkdtemp(join(tmpdir(), "msgboard-drift-"));
  const env = {
    ...process.env,
    // Fail instead of waiting on a password prompt nobody can answer.
    GIT_TERMINAL_PROMPT: "0",
    ...gitAuthEnv({ remote: pin.remote, token: process.env.GITLAB_TOKEN }),
  };
  const git = async (...args: string[]): Promise<string> => {
    const { stdout } = await run("git", ["-C", dir, ...args], {
      env,
      maxBuffer: 32 * 1024 * 1024,
    });
    return stdout;
  };
  try {
    await git("init", "-q", ".");
    await git("remote", "add", "upstream", pin.remote);
    await git(
      "fetch",
      "-q",
      "--depth",
      "1",
      "--filter=blob:none",
      "upstream",
      pin.branch,
    );
    const commit = (await git("rev-parse", "FETCH_HEAD")).trim();
    const objects: Record<string, string> = {};
    for (const group of planQueries(pin.watched)) {
      Object.assign(
        objects,
        parseLsTree(await git("ls-tree", "FETCH_HEAD", "--", ...group)),
      );
    }
    return { commit, objects };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};
