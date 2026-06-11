<script lang="ts">
  import Icon from '@iconify/svelte'
</script>

<!-- The venue callout: a felt-table panel that breaks the page rhythm on purpose —
     deep green + brass, echoing games.msgboard.xyz's card-room look. -->
<div class="flex w-full justify-center px-4 py-16">
  <div
    class="relative w-full max-w-5xl overflow-hidden rounded-2xl text-white shadow-xl ring-1 ring-amber-400/30"
    style="background: linear-gradient(180deg, #11301d, #0b2014)">
    <div
      class="pointer-events-none absolute inset-0"
      style="background: radial-gradient(70% 60% at 50% 0%, rgba(224,168,52,0.16), transparent 70%)">
    </div>
    <div class="relative flex flex-col items-center gap-5 px-6 py-12 text-center sm:px-12">
      <div class="grid size-12 place-items-center rounded-full bg-amber-400/10 ring-1 ring-amber-400/40">
        <Icon icon="mdi:cards-playing-outline" class="size-7 text-amber-400" />
      </div>
      <h2 class="text-3xl font-bold">
        MsgBoard <span class="bg-gradient-to-br from-amber-200 via-amber-400 to-orange-500 bg-clip-text text-transparent">Games</span>
      </h2>
      <p class="max-w-2xl text-gray-300">
        A provably fair venue, supercharged by MsgBoard: coin flips and a numbers game settled by validator
        entropy, never by the house — and the validators coordinate with proof-of-work stamps instead of
        gas, so fees don't bleed the odds. Every draw ships with a receipt your browser re-checks against
        the chain — <em class="not-italic font-semibold text-amber-300">don't trust the table, audit it</em>.
        Live on PulseChain testnet v4 with free test PLS.
      </p>
      <div class="flex flex-wrap items-center justify-center gap-3 pt-1">
        <a
          href="https://games.msgboard.xyz"
          target="_blank"
          rel="noopener noreferrer"
          class="rounded-full bg-amber-400 px-6 py-2.5 text-sm font-semibold text-gray-950 shadow-lg shadow-amber-500/20 transition hover:bg-amber-300">
          Enter the venue →
        </a>
        <a
          href="#/games"
          class="rounded-full px-5 py-2.5 text-sm text-gray-300 ring-1 ring-white/15 transition hover:text-white hover:ring-white/30">
          How the fairness works
        </a>
      </div>
    </div>
  </div>
</div>
