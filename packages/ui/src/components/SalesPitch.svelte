<script lang="ts">
  import Icon from '@iconify/svelte';
</script>

<div class="flex flex-col md:flex-row justify-between gap-4 md:gap-8 p-4 md:p-8 max-w-7xl mx-auto">
  <div class="group flex-1 text-center p-8 rounded-xl transition-all duration-200 hover:-translate-y-1 border border-slate-200/10">
    <div class="flex justify-center mb-4">
      <Icon icon="mdi:shield-check" width="32" height="32" class="text-slate-600 dark:text-slate-400 transition-colors duration-200 group-hover:text-emerald-500" />
    </div>
    <h3 class="text-2xl font-semibold mb-4 text-slate-800 dark:text-gray-100">Censorship-Resistant</h3>
    <p class="text-base leading-relaxed text-slate-600 dark:text-gray-300">
      Messages flow freely across the peer-to-peer network, unstoppable by any authority. Your voice, always heard.
    </p>
  </div>

  <div class="group flex-1 text-center p-8 rounded-xl transition-all duration-200 hover:-translate-y-1 border border-slate-200/10">
    <div class="flex justify-center mb-4">
      <Icon icon="mdi:lightning-bolt" width="32" height="32" class="text-slate-600 dark:text-slate-400 transition-colors duration-200 group-hover:text-emerald-500" />
    </div>
    <h3 class="text-2xl font-semibold mb-4 text-slate-800 dark:text-gray-100">Lightning-Fast & Ephemeral</h3>
    <p class="text-base leading-relaxed text-slate-600 dark:text-gray-300">
      Messages are temporary and lightweight, delivering speed and scalability without cluttering the network.
    </p>
  </div>

  <div class="group flex-1 text-center p-8 rounded-xl transition-all duration-200 hover:-translate-y-1 border border-slate-200/10">
    <div class="flex justify-center mb-4">
      <Icon icon="mdi:postage-stamp" width="32" height="32" class="text-slate-600 dark:text-slate-400 transition-colors duration-200 group-hover:text-emerald-500" />
    </div>
    <h3 class="text-2xl font-semibold mb-4 text-slate-800 dark:text-gray-100">Permissionless, Paid in Work</h3>
    <p class="text-base leading-relaxed text-slate-600 dark:text-gray-300">
      No gas, no token, no account — you mint your own proof-of-work <span class="font-medium text-emerald-600 dark:text-emerald-400">stamp</span> for each message. Anyone can mint one; everyone must — that stamp is the gate that keeps the board spam-resistant.
    </p>
  </div>
</div>
