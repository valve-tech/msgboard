# Vendored Random-protocol sources

`ConsumerReceiver.sol`, `IRandom.sol` (this dir) and `../PreimageLocation.sol` are byte-identical
copies of the Random protocol sources from gibsfinance/random `packages/contracts` (snapshot at the
2026-07 games-platform extraction). They are vendored — not imported from the `@gibs/random` npm
package — because they are compiled INTO the already-deployed game contracts (CoinFlip, Raffle,
GameBase graph): keeping the exact sources here guarantees the compilation unit stays identical to
what is live on 943/369. Do not edit; if the protocol changes upstream, the games must be
REDEPLOYED before these copies may be refreshed.
