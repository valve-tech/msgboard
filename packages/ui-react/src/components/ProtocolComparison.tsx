type Product = {
  name: string
  censorshipResistance: string
  spamPrevention: string
  privacy: string
  scalability: string
  easeOfUse: string
  uptime: string
}

const keys: (keyof Product)[] = [
  'censorshipResistance',
  'spamPrevention',
  'privacy',
  'scalability',
  'easeOfUse',
  'uptime',
]

const products: Product[] = [
  {
    name: 'MsgBoard',
    censorshipResistance: '✅ Unstoppable P2P Relaying',
    spamPrevention: '✅ Proof of Work',
    privacy: '🟡 Metadata Exposed to Contact Node',
    scalability: '✅ High with P2P efficiency',
    easeOfUse: '✅ Simple JSON-RPC API',
    uptime: "✅ Backed by the chain's nodes",
  },
  {
    name: 'Waku',
    censorshipResistance: '✅ Decentralized routing',
    spamPrevention: '✅ Rate limiting (RLN)',
    privacy: '🟡 Nullifier Based Messages',
    scalability: '✅ Sharding support',
    easeOfUse: '🟡 Complex protocols',
    uptime: '💥 Few Relayers',
  },
  {
    name: 'Nostr',
    censorshipResistance: '✅ Relay switching',
    spamPrevention: '🟡 Fractured Network',
    privacy: '🟡 Relay Dependent',
    scalability: '🟡 Relay Limited',
    easeOfUse: '✅ Simple JSON events',
    uptime: '🟡 Many Relayers',
  },
]

const capitalize = (word: string) => word.charAt(0).toUpperCase() + word.substring(1)
const toCapitalizedWords = (name: string) =>
  (name.match(/[A-Za-z][a-z]*/g) || []).map(capitalize).join(' ')

/** Ported from `ProtocolComparison.svelte` — the decentralized-messaging comparison table. */
export function ProtocolComparison() {
  return (
    <div className="bg-gray-50 dark:bg-gray-900 border-y border-gray-200 dark:border-gray-700 py-16 px-4">
      <div className="max-w-7xl mx-auto">
        <h2 className="text-center text-gray-800 dark:text-gray-100 mb-8 text-3xl font-bold">
          Decentralized Messaging Protocols
        </h2>
        <div className="overflow-x-auto rounded-lg shadow-sm bg-white dark:bg-gray-800">
          <table className="w-full text-sm md:text-base whitespace-nowrap">
            <thead>
              <tr className="bg-gray-50 dark:bg-gray-700">
                <th className="px-4 py-3 text-left font-semibold text-gray-700 dark:text-gray-200">
                  Feature
                </th>
                <th className="px-4 py-3 text-left font-semibold text-gray-700 dark:text-gray-200">
                  MsgBoard
                </th>
                <th className="px-4 py-3 text-left font-semibold text-gray-700 dark:text-gray-200">
                  Waku
                </th>
                <th className="px-4 py-3 text-left font-semibold text-gray-700 dark:text-gray-200">
                  Nostr
                </th>
              </tr>
            </thead>
            <tbody>
              {keys.map((key) => (
                <tr
                  key={key}
                  className="hover:bg-gray-50 dark:hover:bg-gray-700 border-b border-gray-100 dark:border-gray-700">
                  <td className="px-4 py-3 font-medium text-gray-600 dark:text-gray-300">
                    {toCapitalizedWords(key)}
                  </td>
                  {products.map((product) => (
                    <td key={product.name} className="px-4 py-3">
                      {product[key]}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
