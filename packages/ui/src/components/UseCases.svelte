<script lang="ts">
  import Icon from '@iconify/svelte';
  import Carousel from './Carousel.svelte';

  interface UseCase {
    title: string;
    description: string;
    icon: string;
  }

  const useCases: UseCase[] = [
    {
      title: "Multi-Sigs",
      description: "Accounts can share signatures with multi sig partners to distribute consent of an action without writing anything on chain.",
      icon: "mdi:account-multiple-check" // Multiple users with checkmark
    },
    {
      title: "Intent Distribution",
      description: "Intents can be shared with solvers to execute on chain without relying on a central coordinator or service.",
      icon: "mdi:lightning-bolt" // Lightning bolt for quick execution
    },
    {
      title: "Onboarding and Education",
      description: "Proof of work can be used as a token gated means to mint tokens and onboard users.",
      icon: "mdi:school" // School/education icon
    },
    {
      title: "Action Requests",
      description: "Wallets can signal their desire for an action to be taken on their behalf.",
      icon: "mdi:gesture-tap-button" // Tap/request icon
    },
    {
      title: "Account Abstraction",
      description: "Accounts can request actions to be taken on their behalf by sharing signatures - without relying on a central coordinator or service.",
      icon: "mdi:account-cog" // Account with settings/abstraction
    },
    {
      title: "Antagonistic Games",
      description: "Games requiring impartial inputs can use msgboard to pit players' incentives against each other and complete rounds promptly.",
      icon: "mdi:chess-queen" // Link/chain icon
    }
  ];
</script>

<div class="flex flex-col gap-4 text-center py-16 px-4">
  <h2 class="text-3xl font-bold text-slate-900 dark:text-gray-100 pb-4">Use Cases</h2>
  <div class="w-full max-w-7xl mx-auto">
    <Carousel items={useCases} label="Use cases">
      {#snippet card(useCase)}
        <div class="group flex h-full w-full flex-col text-center p-6 rounded-xl border border-slate-200 dark:border-gray-700 transition-all duration-200 hover:-translate-y-1 bg-white dark:bg-gray-800 shadow-sm">
          <div class="flex justify-center mb-4">
            <Icon icon={useCase.icon} width="32" height="32" class="text-slate-600 dark:text-gray-300 transition-colors duration-200 group-hover:text-blue-600 dark:group-hover:text-blue-400" />
          </div>
          <h3 class="text-xl font-semibold mb-3 text-slate-900 dark:text-gray-100">{useCase.title}</h3>
          <p class="text-slate-600 dark:text-gray-300">{useCase.description}</p>
        </div>
      {/snippet}
    </Carousel>
  </div>
</div>
