import { useRef, useState } from 'react'

interface Props {
  accept?: string
  label: string
  hint: string
  onFile: (f: File) => void
}

/** A big tap target that opens the file picker (Files app on iPad) and accepts drag & drop. */
export default function FilePicker({ accept, label, hint, onFile }: Props) {
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
      <button className="primary" onClick={() => input.current?.click()}>
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
