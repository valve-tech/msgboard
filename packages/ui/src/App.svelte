<script lang="ts">
  import { page } from './lib/page.svelte'
  import Home from './pages/Home.svelte'
  import DocsPortal from './pages/DocsPortal.svelte'
  import Examples from './pages/Examples.svelte'
  import Games from './pages/Games.svelte'
  import RedirectToHome from './pages/RedirectToHome.svelte'
  $inspect(page.route.id)
</script>

{#if page.route.id === '/'}
  <Home />
{:else if page.route.id === '/docs'}
  <DocsPortal />
{:else if page.route.id === '/examples'}
  <Examples />
{:else if page.route.id === '/games'}
  <Games />
{:else}
  <RedirectToHome />
{/if}
