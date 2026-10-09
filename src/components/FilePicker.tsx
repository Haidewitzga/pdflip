import { useRef, useState } from 'react'

interface Props {
  accept?: string
  label: string
  hint: string
  onFile: (f: File) => void
  /** Name of the chosen file; shown with a button to remove it. */
  fileName?: string
  onClear?: () => void
}

/** A big tap target that opens the file picker (Files app on iPad) and accepts drag & drop. */
export default function FilePicker({ accept, label, hint, onFile, fileName, onClear }: Props) {
  const input = useRef<HTMLInputElement>(null)
  const [over, setOver] = useState(false)
  return (
    <div
      className={`picker${over ? ' over' : ''}`}
      onDragOver={(e) => {
        e.preventDefault()
        setOver(true)
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault()
        setOver(false)
        const f = e.dataTransfer.files[0]
        if (f) onFile(f)
      }}
    >
      {fileName && (
        <span className="file-chip">
          <svg className="file-icon" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M6 2h8l5 5v13a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2z" />
            <path d="M14 2v5h5" />
          </svg>
          <span className="file-name">{fileName}</span>
          {onClear && (
            <button className="file-remove" onClick={onClear} aria-label={`Remove ${fileName}`} title="Remove file">
              ×
            </button>
          )}
        </span>
      )}
      <button className={fileName ? '' : 'primary'} onClick={() => input.current?.click()}>
        {label}
      </button>
      <span className="muted">{hint}</span>
      <input
        ref={input}
        type="file"
        accept={accept}
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0]
          if (f) onFile(f)
          e.target.value = ''
        }}
      />
    </div>
  )
}
