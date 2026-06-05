<script lang="ts">
  import Welcome from '../components/Welcome.svelte'
  import FullScreen from '../components/FullScreen.svelte'
  import SalesPitch from '../components/SalesPitch.svelte'
  import ProtocolComparison from '../components/ProtocolComparison.svelte'
  import Interactive from '../components/Interactive.svelte'
  import NextSteps from '../components/NextSteps.svelte'
  import Footer from '../components/Footer.svelte'
  import Docs from '../components/Docs.svelte'
  import UseCases from '../components/UseCases.svelte'
  import JoinNetwork from '../components/JoinNetwork.svelte'
  import SideToc from '../components/SideToc.svelte'

  const sections = [
    { id: 'overview', label: 'Overview' },
    { id: 'try-it', label: 'Try it' },
    { id: 'use-cases', label: 'Use cases' },
    { id: 'api', label: 'API' },
    { id: 'network', label: 'Network' },
    { id: 'compare', label: 'Compare' },
    { id: 'next-steps', label: 'Next steps' },
  ]
</script>

<SideToc {sections} />

<section id="top"><Welcome /></section>
<section id="overview" class="scroll-mt-16"><SalesPitch /></section>
<section id="try-it" class="scroll-mt-16">
  <FullScreen id="interactive-container" class="flex bg-gray-50 dark:bg-gray-900 w-full flex-row items-center justify-center shadow">
    <Interactive />
  </FullScreen>
</section>
<section id="use-cases" class="scroll-mt-16"><UseCases /></section>
<section id="api" class="scroll-mt-16"><Docs /></section>
<section id="network" class="scroll-mt-16"><JoinNetwork /></section>
<section id="compare" class="scroll-mt-16"><ProtocolComparison /></section>
<section id="next-steps" class="scroll-mt-16"><NextSteps /></section>
<Footer />
