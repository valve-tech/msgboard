<script lang="ts">
  import Code from './Code.svelte'

  type JsonSchema = {
    $ref?: string
    type?: string
    items?: JsonSchema
    properties?: Record<string, JsonSchema>
    required?: string[]
    description?: string
    pattern?: string
    title?: string
  }
  type MethodParam = { name: string; required?: boolean; schema: JsonSchema }
  type Method = {
    name: string
    summary?: string
    params: MethodParam[]
    result: { name: string; schema: JsonSchema }
    // example shape varies per method; only its params/result values are read
    examples?: { params?: { value: unknown }[]; result?: { value: unknown } }[]
  }
  type OpenRpc = { methods: Method[]; components?: { schemas?: Record<string, JsonSchema> } }

  let { openrpc }: { openrpc: OpenRpc } = $props()

  // hosted spec + one-click Playground (it fetches the spec via ?schemaUrl=)
  const specUrl = 'https://msgboard.xyz/openrpc.json'
  const playgroundUrl = `https://playground.open-rpc.org/?schemaUrl=${encodeURIComponent(specUrl)}`

  const schemas = openrpc.components?.schemas ?? {}
  const refName = (ref: string) => ref.split('/').pop() as string
  const schemaId = (name: string) => `schema-${name}`
  const methodId = (name: string) => `method-${name}`

  const typeLabel = (schema?: JsonSchema): string => {
    if (!schema) return 'any'
    if (schema.$ref) return refName(schema.$ref)
    if (schema.type === 'array') return `${typeLabel(schema.items)}[]`
    return schema.type ?? 'object'
  }
  // the schema name a type points at (for cross-linking), or null for a primitive
  const refTarget = (schema?: JsonSchema): string | null => {
    if (!schema) return null
    if (schema.$ref) return refName(schema.$ref)
    if (schema.type === 'array' && schema.items?.$ref) return refName(schema.items.$ref)
    return null
  }
  const scrollToId = (id: string) =>
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })

  const requestJson = (method: Method, ex?: Method['examples'][number]) =>
    JSON.stringify(
      { jsonrpc: '2.0', id: 1, method: method.name, params: (ex?.params ?? []).map((p) => p.value) },
      null,
      2,
    )
  const responseJson = (ex?: Method['examples'][number]) =>
    JSON.stringify({ jsonrpc: '2.0', id: 1, result: ex?.result?.value }, null, 2)

  const fields = (schema: JsonSchema) => {
    const required = schema.required ?? []
    return Object.entries(schema.properties ?? {}).map(([name, prop]) => ({
      name,
      prop,
      required: required.includes(name),
    }))
  }
</script>

<!-- renders a type as a click-to-scroll link when it references a schema, else plain -->
{#snippet typeRef(schema?: JsonSchema)}
  {#if refTarget(schema)}
    <button
      type="button"
      class="font-mono text-indigo-600 hover:underline dark:text-indigo-400"
      onclick={() => scrollToId(schemaId(refTarget(schema)!))}>{typeLabel(schema)}</button>
  {:else}
    <code class="font-mono text-gray-700 dark:text-gray-300">{typeLabel(schema)}</code>
  {/if}
{/snippet}

<div class="flex flex-col gap-4">
  <div class="flex flex-wrap items-center justify-between gap-3">
    <h2 id="json-rpc-methods" class="scroll-mt-16 text-2xl font-bold text-slate-900 dark:text-gray-100">JSON-RPC methods</h2>
    <a
      href={playgroundUrl}
      target="_blank"
      rel="noopener noreferrer"
      class="inline-flex items-center gap-1.5 rounded-full bg-indigo-600 px-4 py-1.5 text-sm font-medium text-white transition hover:bg-indigo-500">
      Open in OpenRPC Playground ↗
    </a>
  </div>

  {#each openrpc.methods as method}
    <div
      id={methodId(method.name)}
      class="scroll-mt-4 rounded-xl border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-900">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <code class="font-mono text-base font-semibold text-amber-600 dark:text-amber-400">{method.name}</code>
        <span class="text-sm text-gray-500 dark:text-gray-400">Returns {@render typeRef(method.result.schema)}</span>
      </div>
      {#if method.summary}
        <p class="mt-1 text-sm text-slate-700 dark:text-gray-300">{method.summary}</p>
      {/if}

      {#if method.params.length}
        <table class="mt-3 w-full border-collapse text-sm">
          <thead>
            <tr class="text-left text-gray-500 dark:text-gray-400">
              <th class="border-b border-gray-200 py-1 pr-3 font-medium dark:border-gray-700">Parameter</th>
              <th class="border-b border-gray-200 py-1 pr-3 font-medium dark:border-gray-700">Type</th>
              <th class="border-b border-gray-200 py-1 font-medium dark:border-gray-700">Required</th>
            </tr>
          </thead>
          <tbody>
            {#each method.params as param}
              <tr>
                <td class="border-b border-gray-100 py-1 pr-3 dark:border-gray-800"><code class="font-mono">{param.name}</code></td>
                <td class="border-b border-gray-100 py-1 pr-3 dark:border-gray-800">{@render typeRef(param.schema)}</td>
                <td class="border-b border-gray-100 py-1 dark:border-gray-800">{param.required ? 'yes' : 'no'}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      {:else}
        <p class="mt-3 text-sm italic text-gray-500 dark:text-gray-400">No parameters.</p>
      {/if}

      {#if method.examples?.length}
        <details class="group mt-3">
          <summary class="cursor-pointer text-sm font-medium text-indigo-600 hover:underline dark:text-indigo-400">
            Example request &amp; response
          </summary>
          <div class="mt-2 flex flex-col gap-2">
            <Code code={requestJson(method, method.examples[0])} lang="json" preBase="w-full" />
            <Code code={responseJson(method.examples[0])} lang="json" preBase="w-full" />
          </div>
        </details>
      {/if}
    </div>
  {/each}

  <h2 id="schemas" class="mt-6 scroll-mt-16 text-2xl font-bold text-slate-900 dark:text-gray-100">Schemas</h2>

  {#each Object.entries(schemas) as [name, schema]}
    <div
      id={schemaId(name)}
      class="scroll-mt-4 rounded-xl border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-900">
      <code class="font-mono text-base font-semibold text-slate-900 dark:text-gray-100">{name}</code>
      {#if schema.description}
        <p class="mt-1 text-sm text-slate-700 dark:text-gray-300">{schema.description}</p>
      {/if}

      {#if schema.type === 'object' && schema.properties}
        <table class="mt-3 w-full border-collapse text-sm">
          <thead>
            <tr class="text-left text-gray-500 dark:text-gray-400">
              <th class="border-b border-gray-200 py-1 pr-3 font-medium dark:border-gray-700">Field</th>
              <th class="border-b border-gray-200 py-1 pr-3 font-medium dark:border-gray-700">Type</th>
              <th class="border-b border-gray-200 py-1 font-medium dark:border-gray-700">Description</th>
            </tr>
          </thead>
          <tbody>
            {#each fields(schema) as f}
              <tr>
                <td class="border-b border-gray-100 py-1 pr-3 align-top dark:border-gray-800">
                  <code class="font-mono">{f.name}</code>{#if f.required}<span class="ml-1 text-xs text-amber-600 dark:text-amber-400">*</span>{/if}
                </td>
                <td class="border-b border-gray-100 py-1 pr-3 align-top dark:border-gray-800">{@render typeRef(f.prop)}</td>
                <td class="border-b border-gray-100 py-1 align-top text-slate-600 dark:text-gray-400">{f.prop.description ?? ''}</td>
              </tr>
            {/each}
          </tbody>
        </table>
        <p class="mt-2 text-xs text-gray-400">* required</p>
      {:else if schema.type === 'array'}
        <p class="mt-2 text-sm text-slate-700 dark:text-gray-300">Array of {@render typeRef(schema.items)}</p>
      {:else if schema.type === 'string' && schema.pattern}
        <p class="mt-2 text-sm text-slate-700 dark:text-gray-300">String matching <code class="font-mono">{schema.pattern}</code></p>
      {:else}
        <p class="mt-2 text-sm text-slate-700 dark:text-gray-300">Type: <code class="font-mono">{schema.type}</code></p>
      {/if}
    </div>
  {/each}
</div>
