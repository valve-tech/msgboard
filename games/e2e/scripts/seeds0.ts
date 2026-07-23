import * as viem from 'viem'
import { mnemonicToAccount } from 'viem/accounts'

/**
 * The seeds0 secret convention: validator i's preimage j is the raw HD private key of the
 * dedicated seeds0 mnemonic at accountIndex i*SECRET_STRIDE + j (stride 100k = 100k draws per validator before a convention change). Secrets are re-derivable by
 * anything holding seeds0 (ink-pools writes the preimages; cast-watcher reveals the secrets);
 * nothing is ever stored. seeds0 is used ONLY as a secret seed, never as a funded wallet.
 */
export const SECRET_STRIDE = 100_000

export const seeds0Secret = (seeds0: string, accountIndex: number): viem.Hex => {
  const hd = mnemonicToAccount(seeds0, { accountIndex }).getHdKey()
  return viem.toHex(hd.privateKey!)
}
