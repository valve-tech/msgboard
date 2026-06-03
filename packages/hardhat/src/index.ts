import { extendEnvironment, extendProvider, extendConfig } from 'hardhat/config'
import { lazyObject } from 'hardhat/plugins'
import type { HardhatConfig, HardhatUserConfig, MsgBoardConfig, MsgBoardUserConfig } from 'hardhat/types'
import * as msgboard from '@msgboard/sdk'

import { globalDefaultSettings, MsgBoardProvider, providers } from './provider'
import type { MsgBoardSettings } from './types'
// This import is needed to let the TypeScript compiler know that it should include your type
// extensions in your npm package's types file.
import './type-extensions'
import './tasks'

extendConfig((config: HardhatConfig, userConfig: Readonly<HardhatUserConfig>) => {
  const userConf = userConfig as MsgBoardUserConfig
  const c = config as unknown as MsgBoardConfig
  c.msgboard = {
    ...globalDefaultSettings,
    ...(userConf.msgboard ?? {}),
  }
})

extendEnvironment((hre) => {
  // We add a field to the Hardhat Runtime Environment here.
  // We use lazyObject to avoid initializing things until they are actually
  // needed.
  hre.msgboard = lazyObject(() => {
    return new msgboard.MsgBoardClient(msgboard.wrapLegacySend(hre.network.provider))
  })
})

extendProvider((provider, config, network) => {
  const isHardhatNetwork = network === 'hardhat'
  const c = config as unknown as MsgBoardSettings
  const prov = new MsgBoardProvider(provider, isHardhatNetwork)
  prov.setNodeConstraints(c)
  providers.add(prov)
  return prov
})
