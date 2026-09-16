import { useCallback, useState } from 'react'
import { Icon } from '@iconify/react'
import type { Petition } from '@msgboard/petition'
import { Field, TextInput } from './ui.js'

export type CreateState = 'idle' | 'posting' | 'capturing' | 'done' | 'error'

/**
 * `CreatePetition` — statement in, a PoW-stamped descriptor posted to the board (off the main
 * thread — the caller's `onSubmit` routes through the worker board), then polled until the
 * read-side reflects it (captured ✓).
 */
export function CreatePetition(props: {
  onSubmit: (statement: string) => Promise<Petition>
  onDone: (petition: Petition) => void
  disabledReason?: string | null
}) {
  const [statement, setStatement] = useState('')
  const [state, setState] = useState<CreateState>('idle')
  const [error, setError] = useState<string | null>(null)
  const [created, setCreated] = useState<Petition | null>(null)

  const submit = useCallback(async () => {
    if (!statement.trim()) return
    setError(null)
    setState('posting')
    try {
      setState('capturing')
      const petition = await props.onSubmit(statement.trim())
      setCreated(petition)
      setState('done')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to create the petition')
      setState('error')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statement, props.onSubmit])

  if (state === 'done' && created) {
    return (
      <div className="notice info">
        <div className="disp" style={{ fontSize: 15, marginBottom: 6 }}>
          ✓ Captured
        </div>
        <p className="hint" style={{ margin: '0 0 10px' }}>
          Your petition is live on the read-side index. Anyone can now sign it.
        </p>
        <button type="button" className="btn brass" onClick={() => props.onDone(created)}>
          <Icon icon="mdi:arrow-right" /> View petition
        </button>
      </div>
    )
  }

  return (
    <div>
      <Field label="Statement" hint="What this petition asks for. This exact text is what every signer's EIP-712 signature commits to.">
        <TextInput value={statement} onChange={setStatement} placeholder="We petition for…" multiline />
      </Field>
      {props.disabledReason && <div className="notice info">{props.disabledReason}</div>}
      <div className="btnrow">
        <button
          type="button"
          className="btn brass"
          onClick={() => void submit()}
          disabled={!statement.trim() || state === 'posting' || state === 'capturing' || !!props.disabledReason}>
          {state === 'posting' || state === 'capturing' ? <Icon icon="mdi:loading" className="spin" /> : <Icon icon="mdi:fountain-pen-tip" />}
          {state === 'posting' ? 'Stamping…' : state === 'capturing' ? 'Waiting for capture…' : 'Create petition'}
        </button>
      </div>
      {state === 'error' && error && <div className="notice err">{error}</div>}
    </div>
  )
}
