<script lang="ts">
  import Icon from '@iconify/svelte'
  type Value = string | null | number | undefined | bigint | boolean
  type Props = {
    copied?: boolean
    value?: Value
    copy?: (value: Value) => void
    classes?: string
  }

  let copied = $state(false)

  const defaultCopy = (value: Value) => {
    navigator.clipboard.writeText(`${value}`)
    copied = true
    setTimeout(() => {
      copied = false
    }, 200)
  }
  const { copy = defaultCopy, value = '', classes = '' }: Props = $props()
</script>
<button
  type="button"
  class="inline-block min-w-6 copier transition-opacity duration-200 {classes}"
  class:opacity-0={copied}
  onclick={(e) => {
    e.stopPropagation()
    copy(value)
  }}><Icon class="inline" icon="ph:copy" /></button>
