interface Props {
  label: string
  done?: number
  total?: number
}

/** Spinner plus an optional progress bar ("Creating PDF… 12 of 98 cards"). */
export default function Progress({ label, done, total }: Props) {
  const known = done !== undefined && total !== undefined && total > 0
  return (
    <div className="progress" role="status" aria-live="polite">
      <span className="spinner" aria-hidden="true" />
      <div className="progress-body">
        <span>
          {label}
          {known && ` ${done} of ${total}`}
        </span>
        <progress max={known ? total : undefined} value={known ? done : undefined} />
      </div>
    </div>
  )
}
