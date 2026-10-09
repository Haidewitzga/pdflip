# Goodnotes flashcard file format (as observed)

Reverse-engineered from decks exported by Goodnotes 5 (7.1.27, schema version 24) for interoperability.
Field numbers are protobuf field numbers; nothing here comes from Goodnotes documentation.

## Archive

A `.goodnotes` file is a zip (deflate, no directory entries):

| File | Content |
|---|---|
| `index.events.pb` | The deck: a stream of length-prefixed events (an append-only log) |
| `notes/<id>` | Content of one card side ("canvas"): stream of element headers and elements |
| `attachments/<id>` | Raw PDF/PNG/JPEG files (card template background, pasted images) |
| `index.notes.pb`, `index.attachments.pb` | Stream of `{1: id, 2: path}` |
| `thumbnail.jpg` | 800×500 cover |
| `schema.pb` / `document.info.pb` | `{1: 24}` / `{1: 1}` |
| `index.search.pb` | empty |

Streams are sequences of `varint length + message`.

## Events

Each event is `{1: object id, <kind>: body}`. Most bodies end with `10: f64 timestamp (ms)`, `11: event uuid`,
`13: device id (u64)`, `14: sequence (ms timestamp, +1 per event)`, `15: 24`.
Mutable values are `{1: value, 2: clock}` with `clock = {1: counter, 2: random u32}`; the highest clock wins.

| Kind | Meaning | Key fields |
|---|---|---|
| 30 | Document | `2: {1: title}`, `9: locale` |
| 6 | Attachment | `1, 2: attachment id`, `5: size`, `6: document id` |
| 2 | Card template page | `4: background PDF attachment`, `8: {1: 1193.28, 2: 745.8}` size, `9: template id` |
| 54 | Canvas (one card side) | `2: canvas id`, `3: {1: page id}`, `4: {1: order key}` |
| 102 | Notes file registered | `1: notes id` (= canvas id + 1 as a 128-bit integer) |
| 151 | Card created | `1: card id`, `4: order`, `5: front`, `6: back` |
| 152 | Card updated | `1: card id`, `3: order`, `4: front`, `5: back` |
| 10 / 34 / 150 | Viewing state (last page / settings / last card) | not needed |

A card side is `{1: content, 2: clock}` where content is either typed text
`{1: {1: "text/plain", 2: text}}` or a canvas reference `{3: {1: canvas id}}`. Cards sort by order key (string).

## Canvas elements (`notes/<id>`)

Each element is preceded by a header `{1: element id, 2: clock, 3: 1 if erased, 8: device, 9: seq, 14: 5381, 16: 24}`.
The element message is `{<kind>: element}`:

- **1 – image**: `2: frame {1: {x, y}, 2: {w, h}}`, `3: {center, size}`, `4: attachment id`
- **7 – ink stroke**: `2: bv41 blob`, `4: colour {1: r, 2: g, 3: b, 4: a}` (zeros omitted), `6: offset {1: dx, 2: dy}`,
  `14: 1` if erased
- **8 – text box**: `2: frame`, `4: transform {1: scale, ...}`, `6: RTF text`

Coordinates are points on a 1193.28 × 745.8 canvas, origin top-left.

### Stroke blob

Apple LZ4 (`bv41` blocks, `bv4$` terminator) containing a typed structure `tpl\0`, `u32 length`, the signature
`vuA(v)A(S(uu))A(S(uuuu))vA(f)\0`, then: `u16`, `f32 width`, `u32 n`, `n × u16` element types, `u32 1`,
`f32 x, y` start point, `u32 m`, `m × (f32 qx, qy, x, y)` quadratic segments, 6 trailing bytes.
