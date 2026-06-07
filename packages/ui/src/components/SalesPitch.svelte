<script lang="ts">
  import Icon from '@iconify/svelte';
</script>

<div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 px-8 py-12 max-w-7xl mx-auto">
  <div class="group flex-1 text-center p-6 rounded-xl transition-all duration-200 hover:-translate-y-1 border border-slate-200/10">
    <div class="flex justify-center mb-4">
      <Icon icon="mdi:shield-check" width="32" height="32" class="text-slate-600 dark:text-slate-400 transition-colors duration-200 group-hover:text-emerald-500" />
    </div>
    <h3 class="text-2xl font-semibold mb-4 text-slate-800 dark:text-gray-100">Censorship-Resistant</h3>
    <p class="text-base leading-relaxed text-slate-600 dark:text-gray-300">
      Messages flow freely across the peer-to-peer network — unstoppable by any authority.
    </p>
  </div>

  <div class="group flex-1 text-center p-6 rounded-xl transition-all duration-200 hover:-translate-y-1 border border-slate-200/10">
    <div class="flex justify-center mb-4">
      <Icon icon="mdi:lightning-bolt" width="32" height="32" class="text-slate-600 dark:text-slate-400 transition-colors duration-200 group-hover:text-emerald-500" />
    </div>
    <h3 class="text-2xl font-semibold mb-4 text-slate-800 dark:text-gray-100">Ephemeral</h3>
    <p class="text-base leading-relaxed text-slate-600 dark:text-gray-300">
      Messages are short-lived and lightweight, aging out without cluttering the network.
    </p>
  </div>

  <div class="group flex-1 text-center p-6 rounded-xl transition-all duration-200 hover:-translate-y-1 border border-slate-200/10">
    <div class="flex justify-center mb-4">
      <Icon icon="mdi:lock-open-variant" width="32" height="32" class="text-slate-600 dark:text-slate-400 transition-colors duration-200 group-hover:text-emerald-500" />
    </div>
    <h3 class="text-2xl font-semibold mb-4 text-slate-800 dark:text-gray-100">Permissionless</h3>
    <p class="text-base leading-relaxed text-slate-600 dark:text-gray-300">
      No gas, no token, no account. Anyone can post — <span class="font-medium text-emerald-600 dark:text-emerald-400">math</span> is the only toll.
    </p>
  </div>

  <div class="group flex-1 text-center p-6 rounded-xl transition-all duration-200 hover:-translate-y-1 border border-slate-200/10">
    <div class="flex justify-center mb-4">
      <Icon icon="mdi:postage-stamp" width="32" height="32" class="text-slate-600 dark:text-slate-400 transition-colors duration-200 group-hover:text-emerald-500" />
    </div>
    <h3 class="text-2xl font-semibold mb-4 text-slate-800 dark:text-gray-100">Paid in Work</h3>
    <p class="text-base leading-relaxed text-slate-600 dark:text-gray-300">
      You mint a proof-of-work <span class="font-medium text-emerald-600 dark:text-emerald-400">stamp</span> for each message — that stamp is what keeps the board spam-free.
    </p>
  </div>
</div>
