import { useMemo, useState, type ReactNode } from 'react'
import { githubIssueLink, makeReport, REPORT_URL, sendReport, type Problem } from '../lib/problems'

interface Props {
  problems: Problem[]
  /** Replaces the default list of problem messages. */
  children?: ReactNode
  /** 'error': something is missing or went wrong; 'warning': the result is still usable. */
  tone?: 'error' | 'warning'
  heading: string
}

type State = { step: 'idle' } | { step: 'sending' } | { step: 'sent'; urls: string[]; duplicate: boolean } | { step: 'failed'; error: string }

/**
 * Shows problems PDFlip ran into and lets the user send a report with one tap. Nothing is sent
 * without that tap, and the user can see exactly what would be sent first.
 */
export default function ProblemReport({ problems, tone = 'error', heading, children }: Props) {
  const [state, setState] = useState<State>({ step: 'idle' })
  const reports = useMemo(() => problems.map(makeReport), [problems])
  if (problems.length === 0) return null

  async function send() {
    setState({ step: 'sending' })
    const urls: string[] = []
    let duplicate = false
    for (const r of reports) {
      const res = await sendReport(r)
      if (!res.ok) {
        setState({ step: 'failed', error: res.error })
        return
      }
      if (res.url) urls.push(res.url)
      duplicate ||= !!res.duplicate
    }
    setState({ step: 'sent', urls, duplicate })
  }

  return (
    <div className={`notice problem tone-${tone}`} role={tone === 'error' ? 'alert' : 'status'}>
      <p>
        <strong>{heading}</strong>
      </p>
      {children ?? (
        <ul>
          {problems.map((p) => (
            <li key={p.signature}>{p.message}</li>
          ))}
        </ul>
      )}

      <p className="muted">
        Help fix this: a report tells the developer what PDFlip could not handle. It contains only the technical details
        below, never your file or the text of your cards, and becomes a public issue on GitHub.
      </p>
      <details className="report-preview">
        <summary>What will be sent</summary>
        <pre>{JSON.stringify(reports.length === 1 ? reports[0] : reports, null, 2)}</pre>
      </details>

      <div className="actions">
        {state.step === 'sent' ? (
          <p role="status">
            ✓ Thank you, {state.duplicate ? 'this problem was already known and your report was added to it' : 'the report was sent'}
            {state.urls.length > 0 && (
              <>
                {' '}
                (
                {state.urls.map((u, i) => (
                  <span key={u}>
                    {i > 0 && ', '}
                    <a href={u} target="_blank" rel="noreferrer">
                      view
                    </a>
                  </span>
                ))}
                )
              </>
            )}
            .
          </p>
        ) : REPORT_URL ? (
          <button onClick={send} disabled={state.step === 'sending'}>
            {state.step === 'sending' ? 'Sending report…' : 'Send report'}
          </button>
        ) : (
          <a className="button" href={githubIssueLink(reports[0])} target="_blank" rel="noreferrer">
            Report on GitHub
          </a>
        )}
      </div>
      {state.step === 'failed' && (
        <p className="error">
          {state.error}{' '}
          <a href={githubIssueLink(reports[0])} target="_blank" rel="noreferrer">
            Report on GitHub instead
          </a>
        </p>
      )}
    </div>
  )
}
