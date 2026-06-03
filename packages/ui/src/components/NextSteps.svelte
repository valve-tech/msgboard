<script lang="ts">
  import Icon from '@iconify/svelte';
</script>

<div class="bg-gradient-to-b from-white to-slate-50 dark:from-gray-900 dark:to-gray-950 py-16 px-4">
  <div class="max-w-7xl mx-auto">
    <h2 class="text-3xl font-bold text-center text-slate-900 dark:text-gray-100 mb-12">Ready to Build the Future?</h2>

    <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-8">
      <!-- API Documentation -->
      <a href="#/docs" class="group flex flex-col p-6 rounded-xl border border-slate-200 dark:border-gray-700 transition-all duration-200 hover:-translate-y-1 bg-white dark:bg-gray-800 shadow-sm">
        <div class="flex items-center justify-center w-12 h-12 rounded-lg bg-blue-100 dark:bg-blue-900/40 mb-4">
          <Icon icon="mdi:book-open-page-variant" class="w-6 h-6 text-blue-600 dark:text-blue-400 group-hover:text-blue-700 dark:group-hover:text-blue-300" />
        </div>
        <h3 class="text-xl font-semibold text-slate-900 dark:text-gray-100 mb-2">Explore the API</h3>
        <p class="text-slate-600 dark:text-gray-300 mb-4">Integrate MsgBoard into your applications with our simple endpoints, and SDK.</p>
        <span class="mt-auto text-blue-600 dark:text-blue-400 group-hover:text-blue-700 dark:group-hover:text-blue-300 flex items-center gap-2">
          Build <Icon icon="mdi:arrow-right" class="w-5 h-5 transition-transform group-hover:translate-x-1" />
        </span>
      </a>

      <!-- PulseChain Info -->
      <a href="https://pulsechain.com" target="_blank" rel="noopener noreferrer" class="group flex flex-col p-6 rounded-xl border border-slate-200 dark:border-gray-700 transition-all duration-200 hover:-translate-y-1 bg-white dark:bg-gray-800 shadow-sm">
        <div class="flex items-center justify-center w-12 h-12 rounded-lg bg-purple-100 dark:bg-purple-900/40 mb-4">
          <Icon icon="mdi:lightning-bolt" class="w-6 h-6 text-purple-600 dark:text-purple-400 group-hover:text-purple-700 dark:group-hover:text-purple-300" />
        </div>
        <h3 class="text-xl font-semibold text-slate-900 dark:text-gray-100 mb-2">Learn About PulseChain</h3>
        <p class="text-slate-600 dark:text-gray-300 mb-4">Discover the blockchain that powers MsgBoard's decentralized messaging.</p>
        <span class="mt-auto text-purple-600 dark:text-purple-400 group-hover:text-purple-700 dark:group-hover:text-purple-300 flex items-center gap-2">
          Learn More <Icon icon="mdi:arrow-right" class="w-5 h-5 transition-transform group-hover:translate-x-1" />
        </span>
      </a>

      <!-- Developer Community -->
      <a href="http://t.me/pulsechain_msgboard" target="_blank" rel="noopener noreferrer" class="group flex flex-col p-6 rounded-xl border border-slate-200 dark:border-gray-700 transition-all duration-200 hover:-translate-y-1 bg-white dark:bg-gray-800 shadow-sm">
        <div class="flex items-center justify-center w-12 h-12 rounded-lg bg-emerald-100 dark:bg-emerald-900/40 mb-4">
          <Icon icon="mdi:telegram" class="w-6 h-6 text-emerald-600 dark:text-emerald-400 group-hover:text-emerald-700 dark:group-hover:text-emerald-300" />
        </div>
        <h3 class="text-xl font-semibold text-slate-900 dark:text-gray-100 mb-2">Join the Community</h3>
        <p class="text-slate-600 dark:text-gray-300 mb-4">Connect with developers, contribute to the project, and help shape the future of decentralized messaging.</p>
        <span class="mt-auto text-emerald-600 dark:text-emerald-400 group-hover:text-emerald-700 dark:group-hover:text-emerald-300 flex items-center gap-2">
          Get Started <Icon icon="mdi:arrow-right" class="w-5 h-5 transition-transform group-hover:translate-x-1" />
        </span>
      </a>
    </div>

    <div class="mt-12 text-center">
      <p class="text-slate-600 dark:text-gray-300 mb-4">Join developers and users worldwide in creating unstoppable Web3 apps with Distributed MsgBoard.</p>
      <a href="#interactive" class="inline-flex items-center justify-center px-6 py-3 rounded-full bg-blue-600 text-white hover:bg-blue-700 transition-colors duration-200">
        Try it Now
        <Icon icon="mdi:arrow-right" class="w-5 h-5 ml-2" />
      </a>
    </div>
  </div>
</div>
