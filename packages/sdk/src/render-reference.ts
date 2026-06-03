/** Renders an OpenRPC document into a markdown API reference. Pure: no file I/O. */

type Schema = {
  $ref?: string
  title?: string
  type?: string
  description?: string
  pattern?: string
  items?: Schema
  properties?: Record<string, Schema>
  required?: string[]
  additionalProperties?: Schema | boolean
}
type Param = { name: string; required?: boolean; schema: Schema }
type Method = {
  name: string
  summary?: string
  params: Param[]
  result: { name: string; schema: Schema }
  examples?: Array<{ name: string; params: Array<{ value: unknown }>; result: { value: unknown } }>
}
type Doc = { methods: Method[]; components: { schemas: Record<string, Schema> } }

const refName = (schema: Schema): string => {
  if (schema.$ref) return schema.$ref.split('/').pop() as string
  if (schema.type === 'array' && schema.items) return `${refName(schema.items)}[]`
  return schema.type ?? 'any'
}

const renderMethod = (m: Method): string => {
  const lines: string[] = []
  lines.push(`### ${m.name}`, '')
  if (m.summary) lines.push(m.summary, '')
  lines.push('| Parameter | Type | Required |', '| --- | --- | --- |')
  if (m.params.length === 0) {
    lines.push('| _(none)_ | | |')
  } else {
    for (const p of m.params) {
      lines.push(`| \`${p.name}\` | \`${refName(p.schema)}\` | ${p.required ? 'yes' : 'no'} |`)
    }
  }
  lines.push('', `**Returns:** \`${refName(m.result.schema)}\``, '')
  const example = m.examples?.[0]
  if (example) {
    const req = { jsonrpc: '2.0', id: 1, method: m.name, params: example.params.map((p) => p.value) }
    const res = { jsonrpc: '2.0', id: 1, result: example.result.value }
    lines.push('```json', JSON.stringify(req, null, 2), '```', '')
    lines.push('```json', JSON.stringify(res, null, 2), '```', '')
  }
  return lines.join('\n')
}

const renderSchema = (name: string, schema: Schema): string => {
  const lines: string[] = []
  lines.push(`### ${name}`, '')
  if (schema.description) lines.push(schema.description, '')
  if (schema.type === 'string' && schema.pattern) {
    lines.push(`String matching \`${schema.pattern}\`.`, '')
    return lines.join('\n')
  }
  if (schema.type === 'array' && schema.items) {
    lines.push(`Array of \`${refName(schema.items)}\`.`, '')
    return lines.join('\n')
  }
  if (schema.properties) {
    lines.push('| Field | Type | Description |', '| --- | --- | --- |')
    for (const [field, prop] of Object.entries(schema.properties)) {
      const required = schema.required?.includes(field) ? ' (required)' : ''
      lines.push(`| \`${field}\`${required} | \`${refName(prop)}\` | ${prop.description ?? ''} |`)
    }
    lines.push('')
    return lines.join('\n')
  }
  if (typeof schema.additionalProperties === 'object') {
    lines.push(`Object whose values are \`${refName(schema.additionalProperties)}\`.`, '')
  }
  return lines.join('\n')
}

export const renderReference = (doc: Doc): string => {
  const out: string[] = []
  out.push('## JSON-RPC methods', '')
  for (const m of doc.methods) out.push(renderMethod(m))
  out.push('## Schemas', '')
  for (const [name, schema] of Object.entries(doc.components.schemas)) out.push(renderSchema(name, schema))
  return out.join('\n').trimEnd() + '\n'
}
