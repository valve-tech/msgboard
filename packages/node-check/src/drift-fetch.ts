import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { parseLsTree, planQueries, type UpstreamPin, type UpstreamState } from './drift.js'

const run = promisify(execFile)

/**
 * Read the watched objects out of upstream, without downloading the repository.
 *
 * A treeless partial clone (`--depth 1 --filter=blob:none`) transfers no blob
 * contents, so a daily run costs about a second. Any failure here is allowed to
 * throw: the caller turns it into CANNOT CHECK, which is louder than a pass.
 */
export const fetchUpstream = async (pin: UpstreamPin): Promise<UpstreamState> => {
  const dir = await mkdtemp(join(tmpdir(), 'msgboard-drift-'))
  const git = async (...args: string[]): Promise<string> => {
    const { stdout } = await run('git', ['-C', dir, ...args], { maxBuffer: 32 * 1024 * 1024 })
    return stdout
  }
  try {
    await git('init', '-q', '.')
    await git('remote', 'add', 'upstream', pin.remote)
    await git('fetch', '-q', '--depth', '1', '--filter=blob:none', 'upstream', pin.branch)
    const commit = (await git('rev-parse', 'FETCH_HEAD')).trim()
    const objects: Record<string, string> = {}
    for (const group of planQueries(pin.watched)) {
      Object.assign(objects, parseLsTree(await git('ls-tree', 'FETCH_HEAD', '--', ...group)))
    }
    return { commit, objects }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}
