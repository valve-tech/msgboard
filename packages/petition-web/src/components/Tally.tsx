/**
 * `Tally` — renders the THREE distinct, clearly-labeled counts. Never conflate these: the
 * read-side "captured" count is posted-but-unverified (anyone can post a `SignatureRecord`
 * claiming any `signer`); "verified" is the only trustless number (client-recomputed via
 * `VerifyPanel`); "on-chain" is hard finality from the settlement indexer.
 */
export function Tally(props: { capturedCount: number; verifiedCount: number; settledCount: number }) {
  return (
    <dl className="meta">
      <div className="mrow">
        <dt>
          captured <span className="q">(posted · unverified)</span>
        </dt>
        <dd>{props.capturedCount}</dd>
      </div>
      <div className="mrow">
        <dt>
          verified <span className="q">(trustless)</span>
        </dt>
        <dd>
          <span className="pill patina">{props.verifiedCount}</span>
        </dd>
      </div>
      <div className="mrow">
        <dt>
          on-chain <span className="q">(settled)</span>
        </dt>
        <dd>
          <span className="pill brass">{props.settledCount}</span>
        </dd>
      </div>
    </dl>
  )
}
