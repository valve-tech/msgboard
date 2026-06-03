# @pulsechain/hardhat-msgboard

Test your msgboard interfaces

[Hardhat](https://hardhat.org) plugin example.

## MsgBoard

MsgBoard allows for decentralized, public communication. Each msgboard instance may behave slightly differently quirks, but so long as the basic interface holds true, it can reliably push the ability to run software closer to the individual. One needs to tightly control which process is utilizing msgboard because it will block as it works through and eventually finds a valid hash.

## Installation

After installing nodejs (+23.6.1 with asdf recommended)

```bash
npm install @pulsechain/hardhat-msgboard
```

Import the plugin in your `hardhat.config.js`:

```js
require("@pulsechain/hardhat-msgboard");
```

Or if you are using TypeScript, in your `hardhat.config.ts`:

```ts
import "@pulsechain/hardhat-msgboard";
```

## Tasks

`msgboard:status`
`msgboard:work`
`msgboard:send`
`msgboard:work:send`

```sh
> hardhat msgboard:status
```

## Environment extensions

<_A description of each extension to the Hardhat Runtime Environment_>

This plugin extends the Hardhat Runtime Environment by adding an `example` field
whose type is `ExampleHardhatRuntimeEnvironmentField`.

## Configuration

<_A description of each extension to the HardhatConfig or to its fields_>

This plugin extends the `HardhatUserConfig`'s `MsgBoardUserConfig` object with an optional `msgboard` field that is only applicable to the hardhat network.

This is an example of how to set it:

```ts
module.exports = {
  msgboard: {
    // only applicable to hardhat network
    enabled: true,
    workMultiplier: 1_000_000n,
    workDivisor: 10_000n,
    messageSizeLimit: 8n * 1024n,
    boardCountLimit: 10_000n,
    blockRangeLimit: 120n,
  },
};
```

## Usage

send messages to the msgboard and read from it

```ts
const msg = await hre.msgboard.doWork('0xcategory...', '0xdata...')
```
