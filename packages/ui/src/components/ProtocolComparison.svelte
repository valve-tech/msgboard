<script lang="ts">
  type Product = {
    name: string;
    censorshipResistance: string;
    spamPrevention: string;
    privacy: string;
    scalability: string;
    easeOfUse: string;
    uptime: string;
  }
  const keys: (keyof Product)[] = ['censorshipResistance', 'spamPrevention', 'privacy', 'scalability', 'easeOfUse', 'uptime']

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
    }
  ]
  function toCapitalizedWords(name: string) {
    var words = name.match(/[A-Za-z][a-z]*/g) || [];
    return words.map(capitalize).join(" ");
  }

  function capitalize(word: string) {
    return word.charAt(0).toUpperCase() + word.substring(1);
  }
</script>

<div class="bg-gray-50 dark:bg-gray-900 border-y border-gray-200 dark:border-gray-700 py-16 px-4">
  <div class="max-w-7xl mx-auto">
  <h2 class="text-center text-gray-800 dark:text-gray-100 mb-8 text-3xl font-bold">Decentralized Messaging Protocols</h2>
  <div class="overflow-x-auto rounded-lg shadow-sm bg-white dark:bg-gray-800">
    <table class="w-full text-sm md:text-base whitespace-nowrap">
      <thead>
        <tr class="bg-gray-50 dark:bg-gray-700">
          <th class="px-4 py-3 text-left font-semibold text-gray-700 dark:text-gray-200">Feature</th>
          <th class="px-4 py-3 text-left font-semibold text-gray-700 dark:text-gray-200">MsgBoard</th>
          <th class="px-4 py-3 text-left font-semibold text-gray-700 dark:text-gray-200">Waku</th>
          <th class="px-4 py-3 text-left font-semibold text-gray-700 dark:text-gray-200">Nostr</th>
        </tr>
      </thead>
      <tbody>
        {#each keys as key}
          <tr class="hover:bg-gray-50 dark:hover:bg-gray-700 border-b border-gray-100 dark:border-gray-700">
            <td class="px-4 py-3 font-medium text-gray-600 dark:text-gray-300">{toCapitalizedWords(key)}</td>
            {#each products as product}
              <td class="px-4 py-3">{product[key]}</td>
            {/each}
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
  </div>
</div>
