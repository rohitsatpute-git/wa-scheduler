import { useMutation } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { api, type Occasion, type SuggestInput } from '../api'
import { loadPrefs, OCCASIONS, OccasionChips, savePrefs, StyleFields, type Prefs } from './SuggestFields'

/** The occasion that fits the scheduled time, shown first. */
function occasionForHour(hour: number | null): Occasion | null {
  if (hour === null) return null
  if (hour >= 4 && hour < 12) return 'good_morning'
  if (hour >= 20 || hour < 3) return 'good_night'
  return null
}

interface Props {
  /** Hour (0-23) the message goes out, to put the matching greeting first. */
  sendHour: number | null
  /** Set when sending to one person: suggestions may use their name. */
  recipientName?: string
  /** Shown on each suggestion's button ("Use", "Add"). */
  pickLabel?: string
  onPick: (text: string) => void
  onClose: () => void
}

export function MessageSuggestions({ sendHour, recipientName, pickLabel = 'Use', onPick, onClose }: Props) {
  const [occasion, setOccasion] = useState<Occasion | null>(null)
  const [note, setNote] = useState('')
  const [prefs, setPrefs] = useState<Prefs>(loadPrefs)
  // The filters the shown results were made with, to tell when they're out of date.
  const [resultKey, setResultKey] = useState<string | null>(null)
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const noteRef = useRef<HTMLInputElement>(null)

  useEffect(() => savePrefs(prefs), [prefs])

  const suggest = useMutation({
    mutationFn: (input: SuggestInput) => api.suggest(input),
    onSuccess: (_data, input) => {
      setResultKey(keyOf(input))
      setPicked(new Set())
    },
  })

  const recommended = occasionForHour(sendHour)
  const current = OCCASIONS.find((o) => o.id === occasion)

  const input = (o: Occasion | null = occasion): SuggestInput | null =>
    o ? { occasion: o, note: note.trim(), recipientName, ...prefs } : null
  const keyOf = (i: SuggestInput) => JSON.stringify(i)
  const needsNote = occasion === 'custom' && !note.trim()
  const stale = Boolean(suggest.data && occasion && resultKey !== keyOf(input()!))

  const run = (o: Occasion | null = occasion) => {
    const i = input(o)
    if (!i || (i.occasion === 'custom' && !i.note)) return
    suggest.mutate(i)
  }

  const pickOccasion = (o: Occasion) => {
    setOccasion(o)
    if (o === 'custom' && !note.trim()) {
      suggest.reset()
      requestAnimationFrame(() => noteRef.current?.focus())
      return
    }
    run(o)
  }

  const pick = (s: string) => {
    setPicked((p) => new Set(p).add(s))
    onPick(s)
  }

  return (
    <div className="suggest-panel" role="region" aria-label="Message suggestions">
      <div className="row between">
        <strong>What’s the occasion?</strong>
        <button type="button" className="icon-button" onClick={onClose} aria-label="Close suggestions">
          ✕
        </button>
      </div>

      <OccasionChips value={occasion} onChange={pickOccasion} recommended={recommended} />

      {occasion && (
        <>
          <input
            ref={noteRef}
            className="suggest-note"
            maxLength={200}
            placeholder={current?.detail ?? 'Add a detail (optional)'}
            aria-label={occasion === 'custom' ? 'Describe the message' : 'Add a detail (optional)'}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                run()
              }
            }}
          />

          <StyleFields value={prefs} onChange={setPrefs} />

          <div className="row wrap">
            <button
              type="button"
              className={stale || !suggest.data ? 'primary' : ''}
              disabled={suggest.isPending || needsNote}
              onClick={() => run()}
            >
              {suggest.isPending ? 'Writing…' : stale ? 'Update suggestions' : suggest.data ? '↻ More options' : 'Suggest'}
            </button>
            {recipientName && <span className="muted small">Personalised for {recipientName}</span>}
            {suggest.error && <span className="error small">{suggest.error.message}</span>}
          </div>
        </>
      )}

      {suggest.isPending && (
        <ul className="suggestions" aria-busy="true" aria-label="Loading suggestions">
          {[0, 1, 2].map((i) => (
            <li key={i} className="suggestion skeleton" />
          ))}
        </ul>
      )}

      {!suggest.isPending && suggest.data && (
        <>
          <ul className={`suggestions${stale ? ' stale' : ''}`}>
            {suggest.data.suggestions.map((s) => (
              <li key={s}>
                <button
                  type="button"
                  className={`suggestion${picked.has(s) ? ' picked' : ''}`}
                  onClick={() => pick(s)}
                >
                  <span className="suggestion-text">{s}</span>
                  <span className="suggestion-use">{picked.has(s) ? '✓ Added' : pickLabel}</span>
                </button>
              </li>
            ))}
          </ul>
          {suggest.data.source === 'templates' && (
            <p className="muted small">
              {occasion === 'custom' || prefs.language !== 'english'
                ? 'AI writing isn’t available right now, so there are no custom or translated suggestions.'
                : 'AI writing isn’t available right now. Showing ready-made messages; filters other than Emoji don’t apply.'}
            </p>
          )}
        </>
      )}
    </div>
  )
}
