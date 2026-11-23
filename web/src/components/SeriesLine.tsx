import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { api, type Message } from '../api'
import { describeDays, seriesPosition } from '../format'

/** "Repeat · Weekdays · message 2 of 5" with links to change or stop the series. */
export function SeriesLine({
  seriesId,
  series,
  occurrence,
}: {
  seriesId: string
  series: NonNullable<Message['series']>
  occurrence: number | null
}) {
  const qc = useQueryClient()
  const stop = useMutation({
    mutationFn: () => api.stopSeries(seriesId),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['messages'] })
      void qc.invalidateQueries({ queryKey: ['message'] })
      void qc.invalidateQueries({ queryKey: ['series'] })
    },
  })
  const active = series.status === 'active'

  return (
    <div className="series-line">
      <span className="repeat-chip">🔁 {describeDays(series.days)}</span>
      <span className="muted small">
        {seriesPosition(series, occurrence)}
        {!active && ` · ${series.status === 'stopped' ? 'stopped' : 'finished'}`}
      </span>
      {active && (
        <span className="actions">
          <Link to={`/series/${seriesId}/edit`} className="small">
            Edit repeat
          </Link>
          <button
            type="button"
            className="link danger small"
            disabled={stop.isPending}
            onClick={() => confirm('Stop repeating? The upcoming send is cancelled; past sends stay in History.') && stop.mutate()}
          >
            Stop repeating
          </button>
        </span>
      )}
      {stop.error && <span className="error small">{stop.error.message}</span>}
    </div>
  )
}
