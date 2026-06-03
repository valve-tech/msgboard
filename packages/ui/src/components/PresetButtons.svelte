<script lang="ts">
  type Props = {
    workAndSend?: () => void
    disabled?: boolean
  }
  const {
    workAndSend = () => {},
    disabled = false,
  }: Props = $props()
</script>

<div class="inline-flex rounded-lg shadow-sm w-full content-stretch">
  <button
    type="button"
    class="bg-white dark:bg-gray-800 flex-grow text-center justify-center py-3 px-4 inline-flex items-center gap-x-2 text-sm font-semibold text-gray-900 dark:text-gray-100 first:rounded-s-lg first:ms-0 last:rounded-e-lg focus:z-10 border border-gray-200 dark:border-gray-700 bg-slate-100 dark:bg-gray-800 shadow-sm hover:bg-gray-50 dark:hover:bg-gray-700"
    onclick={workAndSend}
    {disabled}>
    Work + Send It!
  </button>
</div>
