<script lang="ts">
  import Icon from '@iconify/svelte';
  import Carousel from './Carousel.svelte';

  type Step = {
    href: string;
    external?: boolean;
    icon: string;
    title: string;
    description: string;
    ctaText: string;
    /** full Tailwind class strings (kept literal so they survive purge) */
    border: string;
    iconWrap: string;
    iconText: string;
    cta: string;
  };

  const steps: Step[] = [
    {
      href: '#/examples',
      icon: 'mdi:bullseye-arrow',
      title: 'Run the Examples',
      description: 'Runnable scripts for every use case, plus the live GraphQL archive of historical messages.',
      ctaText: 'See examples',
      border: 'border-amber-300/60 dark:border-amber-500/30',
      iconWrap: 'bg-amber-400/10 ring-1 ring-amber-400/40',
      iconText: 'text-amber-500 dark:text-amber-400',
      cta: 'text-amber-600 dark:text-amber-400 group-hover:text-amber-700 dark:group-hover:text-amber-300',
    },
    {
      href: '#/docs',
      icon: 'mdi:book-open-page-variant',
      title: 'Explore the API',
      description: 'Integrate MsgBoard into your applications with our simple endpoints, and SDK.',
      ctaText: 'Build',
      border: 'border-slate-200 dark:border-gray-700',
      iconWrap: 'bg-blue-100 dark:bg-blue-900/40',
      iconText: 'text-blue-600 dark:text-blue-400 group-hover:text-blue-700 dark:group-hover:text-blue-300',
      cta: 'text-blue-600 dark:text-blue-400 group-hover:text-blue-700 dark:group-hover:text-blue-300',
    },
    {
      href: 'https://pulsechain.com',
      external: true,
      icon: 'mdi:lightning-bolt',
      title: 'Learn About PulseChain',
      description: "Discover the blockchain that powers MsgBoard's decentralized messaging.",
      ctaText: 'Learn More',
      border: 'border-slate-200 dark:border-gray-700',
      iconWrap: 'bg-purple-100 dark:bg-purple-900/40',
      iconText: 'text-purple-600 dark:text-purple-400 group-hover:text-purple-700 dark:group-hover:text-purple-300',
      cta: 'text-purple-600 dark:text-purple-400 group-hover:text-purple-700 dark:group-hover:text-purple-300',
    },
    {
      href: 'http://t.me/pulsechain_msgboard',
      external: true,
      icon: 'mdi:telegram',
      title: 'Join the Community',
      description: 'Connect with developers, contribute to the project, and help shape the future of decentralized messaging.',
      ctaText: 'Get Started',
      border: 'border-slate-200 dark:border-gray-700',
      iconWrap: 'bg-emerald-100 dark:bg-emerald-900/40',
      iconText: 'text-emerald-600 dark:text-emerald-400 group-hover:text-emerald-700 dark:group-hover:text-emerald-300',
      cta: 'text-emerald-600 dark:text-emerald-400 group-hover:text-emerald-700 dark:group-hover:text-emerald-300',
    },
  ];
</script>

<div class="bg-gradient-to-b from-white to-slate-50 dark:from-gray-900 dark:to-gray-950 py-16 px-4">
  <div class="max-w-7xl mx-auto">
    <h2 class="text-3xl font-bold text-center text-slate-900 dark:text-gray-100 mb-12">Ready to Build the Future?</h2>

    <Carousel items={steps} label="Next steps">
      {#snippet card(step)}
        <a
          href={step.href}
          target={step.external ? '_blank' : undefined}
          rel={step.external ? 'noopener noreferrer' : undefined}
          class="group flex h-full w-full flex-col p-6 rounded-xl border {step.border} transition-all duration-200 hover:-translate-y-1 bg-white dark:bg-gray-800 shadow-sm">
          <div class="flex items-center justify-center w-12 h-12 rounded-lg {step.iconWrap} mb-4">
            <Icon icon={step.icon} class="w-6 h-6 {step.iconText}" />
          </div>
          <h3 class="text-xl font-semibold text-slate-900 dark:text-gray-100 mb-2">{step.title}</h3>
          <p class="text-slate-600 dark:text-gray-300 mb-4">{step.description}</p>
          <span class="mt-auto {step.cta} flex items-center gap-2">
            {step.ctaText} <Icon icon="mdi:arrow-right" class="w-5 h-5 transition-transform group-hover:translate-x-1" />
          </span>
        </a>
      {/snippet}
    </Carousel>

    <div class="mt-12 text-center">
      <p class="text-slate-600 dark:text-gray-300 mb-4">Join developers and users worldwide in creating unstoppable Web3 apps with Distributed MsgBoard.</p>
      <a href="#interactive" class="inline-flex items-center justify-center px-6 py-3 rounded-full bg-blue-600 text-white hover:bg-blue-700 transition-colors duration-200">
        Try it Now
        <Icon icon="mdi:arrow-right" class="w-5 h-5 ml-2" />
      </a>
    </div>
  </div>
</div>
