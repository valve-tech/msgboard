<script lang="ts">
  import { onMount } from 'svelte';

  let element: HTMLElement;
  let observer: IntersectionObserver;
  const translateYMax = 0;
  const scaleMax = 1;
  const scaleMin = 0.75;
  const opacityMax = 1;
  const opacityMin = 0.6;
  let topFromMid = $state(0);
  let height = $state(0);
  const percent = $derived(Math.max(0, ((topFromMid - (height / 2)) / height)));
  const translateYMin = $derived(-Math.max(height / 3, 96));
  const translate = $derived(translateYMax - (percent * (translateYMax - translateYMin)));
  const opacity = $derived(opacityMax - (percent * (opacityMax - opacityMin)));
  const scale = $derived(scaleMax - (percent * (scaleMax - scaleMin)));

  const { children, id, class: className } = $props();

  onMount(() => {
    observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          const { boundingClientRect } = entry;
          topFromMid = Math.max(boundingClientRect.top, 0);
          height = boundingClientRect.height;
        });
      },
      {
        threshold: Array.from({ length: 200 }, (_, i) => i / 200),
      }
    );

    if (element) {
      observer.observe(element);
    }

    return () => {
      if (element) {
        observer.unobserve(element);
      }
      observer.disconnect();
    };
  });
</script>

<div
  bind:this={element}
  class="flex grow items-center justify-center flex-row py-24 border-y border-gray-200 dark:border-gray-700 {className}"
  id={id}>
  <div class="w-full flex grow" style="transform: translateY({translate}px) scale({scale}); opacity: {opacity}">
    {@render children()}
  </div>
</div>
