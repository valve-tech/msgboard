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
</script>

<Welcome />
<SalesPitch />
<FullScreen id="interactive-container" class="flex bg-gray-50 dark:bg-gray-900 w-full flex-row items-center justify-center shadow">
  <Interactive />
</FullScreen>
<UseCases />
<Docs />
<JoinNetwork />
<ProtocolComparison />
<NextSteps />
<Footer />
