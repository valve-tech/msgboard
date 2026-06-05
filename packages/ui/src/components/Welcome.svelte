<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { fly } from 'svelte/transition';
  import Icon from '@iconify/svelte';

  // rotating prefix word in the hero title; "MsgBoard" stays on its own line below
  const words = ['Permissionless', 'Stamped by Work', 'Ephemeral', 'Distributed'] as const;
  let index = $state(0);
  let timer: ReturnType<typeof setInterval> | undefined;

  onMount(() => {
    // hold the title still for users who prefer reduced motion
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    timer = setInterval(() => {
      index = (index + 1) % words.length;
    }, 2200);
  });
  onDestroy(() => clearInterval(timer));

  // supported chains shown in the hero — one icon per distinct network logo.
  // 943 (v4 testnet) is intentionally omitted: gib.show renders it with the same
  // PulseChain mark as 369, so it would look like a duplicate.
  const chains = [
    { id: '369', label: 'PulseChain' },
    { id: '1', label: 'Ethereum' },
  ];
  const chainIcon = (id: string) => `https://gib.show/image/${id}?w=48&h=48&format=webp`;

  const scrollToInteractive = () => {
    document.scrollingElement?.scrollTo({
      top: document.querySelector('#interactive')?.getBoundingClientRect().top,
      behavior: 'smooth',
    });
  };
</script>

<!-- Ink hero: a deep panel that reads crisply on both the light and dark page,
     with a warm "stamp" glow + dot-grid texture. -->
<div class="relative overflow-hidden w-full bg-black text-white">
  <!-- warm radial glow behind the title -->
  <div
    class="pointer-events-none absolute inset-0"
    style="background: radial-gradient(60% 55% at 50% 0%, rgba(245,158,11,0.20), transparent 70%)">
  </div>
  <!-- subtle dot grid -->
  <div
    class="pointer-events-none absolute inset-0 opacity-[0.14]"
    style="background-image: radial-gradient(rgba(255,255,255,0.5) 1px, transparent 1px); background-size: 22px 22px">
  </div>

  <div class="relative m-auto flex w-full max-w-3xl flex-col items-center gap-5 px-5 py-14 text-center sm:gap-6 sm:py-20">
    <!-- flat dartboard mark on its own line, in a stamp ring -->
    <div class="grid size-12 place-items-center rounded-full bg-amber-400/10 ring-1 ring-amber-400/40 sm:size-14">
      <Icon icon="mdi:bullseye-arrow" class="size-7 text-amber-400 sm:size-8" />
    </div>

    <h1 class="flex flex-col items-center font-bold leading-[1.05] tracking-tight">
      <!-- rotating word on its own line; single-cell grid overlaps in/out so width never jumps the line below -->
      <span class="grid place-items-center">
        {#key index}
          <span
            style="grid-area: 1 / 1; filter: drop-shadow(0 2px 20px rgba(245,158,11,0.35))"
            in:fly={{ y: 20, duration: 300 }}
            out:fly={{ y: -20, duration: 300 }}
            class="whitespace-nowrap bg-gradient-to-br from-amber-200 via-amber-400 to-orange-500 bg-clip-text text-3xl text-transparent sm:text-5xl md:text-6xl lg:text-7xl">
            {words[index]}
          </span>
        {/key}
      </span>
      <span class="text-3xl text-gray-50 sm:text-5xl md:text-6xl lg:text-7xl">MsgBoard</span>
    </h1>

    <p class="max-w-md px-2 text-sm font-light text-gray-400 text-pretty sm:max-w-xl sm:text-lg md:text-xl">
      Unstoppable, ephemeral messaging for any app — no gas, no token, no account.
    </p>

    <!-- proof-of-work "stamp" motif (honest: states the mechanism, not a fabricated message) -->
    <div class="flex items-center gap-2 font-mono text-[10px] text-amber-300/80 sm:text-sm">
      <span class="size-2 rounded-full bg-amber-400 motion-safe:animate-pulse"></span>
      proof-of-work stamped · no gas
    </div>

    <div class="flex flex-col items-center gap-2">
      <span class="text-[10px] uppercase tracking-[0.2em] text-white/40">Supported on</span>
      <div class="flex flex-row items-center gap-3">
        {#each chains as c}
          <img
            src={chainIcon(c.id)}
            alt={c.label}
            title={c.label}
            class="size-7 rounded-full sm:size-8"
            loading="lazy" />
        {/each}
      </div>
    </div>

    <div class="flex flex-wrap items-center justify-center gap-3 pt-1">
      <button
        class="cursor-pointer rounded-full bg-amber-400 px-6 py-2.5 text-sm font-semibold text-gray-950 shadow-lg shadow-amber-500/20 transition hover:bg-amber-300 sm:text-base"
        type="button"
        onclick={scrollToInteractive}>Try it now</button>
      <a
        href="#/docs"
        class="rounded-full px-5 py-2.5 text-sm text-gray-300 ring-1 ring-white/15 transition hover:text-white hover:ring-white/30 sm:text-base">
        Read the docs →
      </a>
    </div>
  </div>
</div>
