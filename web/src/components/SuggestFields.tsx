import type { Language, Length, Occasion, SuggestInput, Tone } from '../api'

/** Shared by the suggestion panel and the "AI writes it" option of repeating messages. */

export const OCCASIONS: { id: Occasion; label: string; icon: string; detail: string }[] = [
  { id: 'good_morning', label: 'Good morning', icon: '☀️', detail: 'e.g. Monday motivation, rainy day' },
  { id: 'good_night', label: 'Good night', icon: '🌙', detail: 'e.g. after a long day' },
  { id: 'birthday', label: 'Birthday', icon: '🎂', detail: 'e.g. turning 30, for my sister' },
  { id: 'festival', label: 'Festival', icon: '🪔', detail: 'Which festival? e.g. Diwali, Eid, Christmas' },
  { id: 'thank_you', label: 'Thank you', icon: '🙏', detail: 'e.g. for the gift, for helping with the move' },
  { id: 'congrats', label: 'Congrats', icon: '🎉', detail: 'e.g. new job, exam results' },
  { id: 'check_in', label: 'Check-in', icon: '👋', detail: 'e.g. haven’t talked in months' },
  { id: 'reminder', label: 'Reminder', icon: '⏰', detail: 'e.g. meeting at 10am, rent due Friday' },
  { id: 'get_well', label: 'Get well', icon: '💐', detail: 'e.g. after surgery' },
  { id: 'anniversary', label: 'Anniversary', icon: '💍', detail: 'e.g. 10 years, for my parents' },
  { id: 'custom', label: 'Something else', icon: '✏️', detail: 'Describe the message, e.g. invite to my housewarming' },
]

const TONES: { id: Tone; label: string }[] = [
  { id: 'warm', label: 'Warm' },
  { id: 'fun', label: 'Fun' },
  { id: 'formal', label: 'Formal' },
  { id: 'romantic', label: 'Romantic' },
  { id: 'inspiring', label: 'Inspiring' },
]

const LANGUAGES: { id: Language; label: string }[] = [
  { id: 'english', label: 'English' },
  { id: 'hindi', label: 'हिन्दी Hindi' },
  { id: 'hinglish', label: 'Hinglish' },
  { id: 'marathi', label: 'मराठी Marathi' },
]

const LENGTHS: { id: Length; label: string }[] = [
  { id: 'short', label: 'Short' },
  { id: 'medium', label: 'Medium' },
  { id: 'long', label: 'Long' },
]

export type Prefs = Pick<SuggestInput, 'tone' | 'language' | 'length' | 'emoji'>
export const DEFAULT_PREFS: Prefs = { tone: 'warm', language: 'english', length: 'short', emoji: true }
const PREFS_KEY = 'wa-suggest-prefs'

export function loadPrefs(): Prefs {
  try {
    return { ...DEFAULT_PREFS, ...JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}') }
  } catch {
    return DEFAULT_PREFS
  }
}

export function savePrefs(prefs: Prefs) {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs))
  } catch {
    // storage unavailable; prefs just won't persist
  }
}

export function OccasionChips({
  value,
  onChange,
  recommended,
}: {
  value: Occasion | null
  onChange: (o: Occasion) => void
  recommended?: Occasion | null
}) {
  const ordered = recommended
    ? [...OCCASIONS.filter((o) => o.id === recommended), ...OCCASIONS.filter((o) => o.id !== recommended)]
    : OCCASIONS
  return (
    <div className="occasions">
      {ordered.map((o) => (
        <button
          key={o.id}
          type="button"
          className={`occasion${value === o.id ? ' active' : ''}`}
          aria-pressed={value === o.id}
          onClick={() => onChange(o.id)}
        >
          <span aria-hidden="true">{o.icon}</span>
          {o.label}
          {o.id === recommended && <span className="occasion-tag">fits send time</span>}
        </button>
      ))}
    </div>
  )
}

export function StyleFields({ value, onChange }: { value: Prefs; onChange: (p: Prefs) => void }) {
  const set = <K extends keyof Prefs>(k: K, v: Prefs[K]) => onChange({ ...value, [k]: v })
  return (
    <div className="suggest-filters">
      <label className="mini-field">
        Tone
        <select value={value.tone} onChange={(e) => set('tone', e.target.value as Tone)}>
          {TONES.map((t) => (
            <option key={t.id} value={t.id}>
              {t.label}
            </option>
          ))}
        </select>
      </label>
      <label className="mini-field">
        Language
        <select value={value.language} onChange={(e) => set('language', e.target.value as Language)}>
          {LANGUAGES.map((l) => (
            <option key={l.id} value={l.id}>
              {l.label}
            </option>
          ))}
        </select>
      </label>
      <div className="mini-field">
        Length
        <div className="segmented small" role="group" aria-label="Length">
          {LENGTHS.map((l) => (
            <button
              key={l.id}
              type="button"
              className={value.length === l.id ? 'active' : ''}
              aria-pressed={value.length === l.id}
              onClick={() => set('length', l.id)}
            >
              {l.label}
            </button>
          ))}
        </div>
      </div>
      <label className="check mini-check">
        <input type="checkbox" checked={value.emoji} onChange={(e) => set('emoji', e.target.checked)} />
        Emoji
      </label>
    </div>
  )
}
