# Changelog

Version history for `flow-export-v4.json`. The filename stays fixed at `v4`
(that's the flow generation, the 10-node redesign that replaced the 26+ node
`flow-export.json`). The number after the dot tracks revisions within that
generation: any change to the flow's live behavior (`VIDEO_ARGS`, the audio
logic, the node graph itself) bumps it. Docs-only edits to README.md or
FAQ.md don't.

Each version here corresponds to a git tag of the same name, so `git show
v4.2` gets you the exact commit that shipped it.

## v4.3 (2026-07-23)

Audio channel count only ever goes down now, never up. Previously every
non-EAC3 audio source was forced to 5.1 at 384k regardless of its own
channel count, so a stereo AC3 track got synthesized into 5.1. Sources at
6 channels or fewer now keep their own channel count and layout; only
sources above 5.1 (7.1, reported as 8 channels) get downmixed to 5.1.
Bitrate scales with the target channel count (192k for 2 or fewer, 384k
for 3-6). Caught via job `IoZG9j9G0`: a 192k stereo AC3 track became a
384k 5.1 EAC3 track, growing the whole file 7.9% for four invented
channels.

Also fixed `select-streams.js`'s cover-art filter: attachment-typed
streams with no probed width/height used to survive filtering and get
force-encoded by the global `-c:v`, which could crash the job outright.
Caught via job `ZTgdvBR6V`.

## v4.2 (2026-07-20)

Re-synced the embedded `Select Streams` node source, which had drifted
from the cover-art-outranks-real-video fix landed in an earlier commit.
README's node-by-node walkthrough was re-centered on `flow-export-v4.json`
as the primary flow, with `flow-export.json` reframed as the previous
flow kept for historical reference.

## v4.1 (2026-07-20)

Re-synced `Plan Encoders`' embedded source with the CUDA hardware decode
addition (`-hwaccel cuda` on the input side) that had been added directly
to `flow-plugins/plan-encoders.js` but not propagated into the JSON
export.

## v4.0 (2026-07-20)

First export of the v4 redesign: a 10-node linear flow with no branches,
consolidating a 26+ node predecessor's stream-selection and
encoder-decision logic into three Custom JS Function nodes (`Extract SRT
Sub`, `Select Streams`, `Plan Encoders`).
