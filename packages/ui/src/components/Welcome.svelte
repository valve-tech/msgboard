<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { fly } from 'svelte/transition';

  // rotating prefix word in the hero title; "MsgBoard" stays put beside it
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

  // supported chains — gib.show coin icon per network (2x webp keeps small icons crisp)
  const chains = [
    { id: '369', label: 'PulseChain' },
    { id: '1', label: 'Ethereum' },
    { id: '943', label: 'v4 testnet' },
  ];
  const chainIcon = (id: string) => `https://gib.show/image/${id}?w=48&h=48&format=webp`;

  const scrollToInteractive = () => {
    document.scrollingElement?.scrollTo({
      top: document.querySelector('#interactive')?.getBoundingClientRect().top,
      behavior: 'smooth',
    });
  };
</script>

<div class="px-4 m-auto py-12 text-center flex w-full flex-col text-slate-900 bg-gradient-to-tr from-blue-600 via-blue-500 to-purple-600 items-center gap-6">
  <h1 class="mt-8 flex flex-row flex-wrap items-center justify-center gap-x-3 gap-y-1 text-5xl md:text-7xl leading-tight font-bold tracking-tight">
    <span class="text-5xl md:text-6xl">🎯</span>
    <!-- single-cell grid so the leaving/entering words overlap instead of doubling width -->
    <span class="grid place-items-center">
      {#key index}
        <span
          style="grid-area: 1 / 1"
          in:fly={{ y: 24, duration: 300 }}
          out:fly={{ y: -24, duration: 300 }}
          class="whitespace-nowrap bg-gradient-to-r from-white to-gray-200 bg-clip-text text-transparent">
          {words[index]}
        </span>
      {/key}
    </span>
    <span class="bg-gradient-to-r from-white to-gray-200 bg-clip-text text-transparent">MsgBoard</span>
  </h1>

  <p class="text-xl md:text-2xl font-light text-white max-w-2xl mx-auto px-4">
    Unstoppable, ephemeral messaging for any app.
  </p>

  <div class="flex flex-col items-center gap-2">
    <span class="text-xs uppercase tracking-wider text-white/70">Supported on</span>
    <div class="flex flex-row items-center gap-3">
      {#each chains as c}
        <img
          src={chainIcon(c.id)}
          alt={c.label}
          title={c.label}
          class="size-8 rounded-full ring-1 ring-white/30 bg-white/10"
          loading="lazy" />
      {/each}
    </div>
  </div>

  <button
    class="btn bg-white dark:bg-gray-800 dark:text-gray-100 px-4 py-2 rounded-full text-lg max-w-sm flex cursor-pointer"
    type="button"
    onclick={scrollToInteractive}>Try it Now</button>
</div>
