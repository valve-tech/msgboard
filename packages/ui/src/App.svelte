<script lang="ts">
  import { page } from './lib/page.svelte'
  import Home from './pages/Home.svelte'
  import DocsPortal from './pages/DocsPortal.svelte'
  import RedirectToHome from './pages/RedirectToHome.svelte'
  $inspect(page.route.id)
</script>

{#if page.route.id === '/'}
  <Home />
{:else if page.route.id === '/docs'}
  <DocsPortal />
{:else}
  <RedirectToHome />
{/if}
