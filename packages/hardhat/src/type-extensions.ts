import 'hardhat/types/config'
import 'hardhat/types/runtime'

import type { MsgBoardClient } from '@msgboard/sdk'
import type { MsgBoardSettings } from './types'

declare module 'hardhat/types/config' {
  export interface MsgBoardUserConfig {
    msgboard?: Partial<MsgBoardSettings>
  }
  export interface MsgBoardConfig {
    msgboard: MsgBoardSettings
  }
}

declare module 'hardhat/types/runtime' {
  export interface HardhatRuntimeEnvironment {
    msgboard: MsgBoardClient
  }
}
