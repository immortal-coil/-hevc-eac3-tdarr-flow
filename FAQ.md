---
title: FAQ
description: Frequently asked questions about the Tdarr Transcode Pipeline flow.
---

# FAQ

Answers here assume you've read [README.md](README.md). Section links point back to it for the full explanation; this document only covers the questions that come up once you're actually using the flow.

## Contents

- [Why this approach](#why-this-approach)
- [Compatibility](#compatibility)
- [Quality and impact](#quality-and-impact)
- [Operational](#operational)

## Why this approach

### Why not just use Tdarr's stock plugins instead of custom code?

Stock plugins were tried first, and the predecessor flow (`flow-export.json`, kept in-repo for history) used them. The problem wasn't that stock plugins are bad individually, it's that several of them have failure modes that only show up when you chain enough of them together for a correct one-pass transcode. See [Why this exists](README.md#why-this-exists) for the specific bugs: property filters that judge the raw probed source instead of the streams that actually survive, cover-art streams that stock filters can't see, and a property-matching syntax mismatch that silently no-ops an entire filter. The custom JavaScript (JS) nodes exist because each of those bugs needed real code, not another stock node, to fix for good.

### Why HEVC and EAC3 specifically?

High Efficiency Video Coding (HEVC, also called H.265) was chosen for better compression efficiency per bit than the H.264/AVC (Advanced Video Coding) it typically replaces, at a quality level validated with a VMAF sweep. See [Encoder settings](README.md#encoder-settings) for the actual settings and the reasoning behind each one. Enhanced AC-3 (EAC3) was chosen for audio because the flow standardizes every library on it: when a source's audio is already EAC3 at 6 channels or fewer, `Plan Encoders` stream-copies it and preserves Atmos-in-EAC3 metadata; when it isn't, the flow converts to EAC3 while preserving the source's own channel count, only downmixing when the source exceeds 5.1 (7.1 sources go to 5.1, never the other way).

### Why rebuild the flow instead of patching the old one?

The predecessor flow used 26+ stock and custom nodes, several with the bugs described above. Patching each bug individually still leaves you with a flow where correctness depends on remembering every fix and keeping every node correctly ordered. Consolidating the stream-selection and encoder-decision logic into three Custom JS Function nodes (`Extract SRT Sub`, `Select Streams`, `Plan Encoders`) makes the same bugs structurally impossible instead of something you have to remember to avoid. See [Node-by-node reference](README.md#node-by-node-reference).

## Compatibility

### Do I need an NVIDIA GPU?

Only for the default "Turbo" profile, which uses NVENC (NVIDIA's hardware video encoder). If you don't have one, swap in one of the CPU-based `libx265` profiles instead. See [Alternate CPU (libx265) profiles](README.md#alternate-cpu-libx265-profiles) for the three that ship commented out in `plan-encoders.js`, ready to drop in.

### Will this re-encode files that are already HEVC?

No. `Plan Encoders` checks the codec of the surviving video stream, and if it's already `hevc`, it stream-copies with no re-encode. This applies at any resolution, including 4K/UHD. See [UHD / copy-only library handling](README.md#uhd--copy-only-library-handling) if you also want non-HEVC sources in a UHD library left un-re-encoded.

### What happens to subtitle tracks that aren't English?

`Select Streams` marks every embedded subtitle stream removed, regardless of language, not just non-English ones. English subtitles aren't lost: `Extract SRT Sub` pulls the best eligible English track out first and saves it as an external `.eng.srt` sidecar next to the video file, before `Select Streams` runs. If you need other languages preserved, or embedded rather than external subtitles, that's a change to `select-streams.js`, not something the shipped flow does.

### What happens to non-English audio tracks?

`Select Streams` keeps only `eng` and `und` (undetermined, which is also what a missing language tag counts as) audio tracks, marks everything else removed, then dedupes down to exactly one surviving audio track regardless of how many eng/und tracks remain. This flow ships one audio track per file by design. If you need to keep multiple audio languages, that's also a change to the language-filter and dedupe logic in `select-streams.js`.

### Does this handle HDR or Dolby Vision content?

Not actively. On the stream-copy path (source already HEVC), the video bitstream and its metadata, including High Dynamic Range (HDR) metadata, pass through untouched, since nothing decodes or re-encodes it. On the re-encode path (source not HEVC), the flow doesn't detect or specifically handle HDR: the Turbo profile's `--colorspace bt709` equivalent was deliberately dropped from the original HandBrake command when porting to ffmpeg (see the notes under [Encoder settings](README.md#encoder-settings)), and no tonemap step exists. An HDR source that needs re-encoding will be re-encoded as HEVC without HDR-to-SDR (Standard Dynamic Range) tonemapping or explicit HDR metadata handling. This gap is tracked in [Future enhancements](README.md#future-enhancements).

## Quality and impact

### Will this degrade my video quality?

Yes, technically. Any lossy re-encode discards some information relative to the source; that's unavoidable for any HEVC re-encode, not specific to this flow. The Turbo profile's settings (`-cq 31`, `-preset p4`) were chosen after a VMAF sweep specifically to minimize the subjective difference at a reasonable file size and encode speed, not to eliminate the loss entirely. If a source is already HEVC, this concern doesn't apply: those files stream-copy with zero re-encoding.

### Why did some of my files get bigger instead of smaller?

The Turbo profile uses constant-quality (CQ) mode, which targets a fixed perceptual quality level, not a fixed output size or percentage reduction. A source that was already efficiently compressed, a WEBDL or a prior Blu-ray rip, can end up larger under this profile, because the profile is holding quality steady rather than chasing a smaller file. This is expected behavior, not a bug. See the notes under [Encoder settings](README.md#encoder-settings) for real production file-size numbers.

### What happens to commentary tracks?

Audio tracks whose title matches `commentary`, `description`, or `sdh` (Subtitles for the Deaf and Hard-of-hearing, in this case matched against audio track titles too) are marked removed during the language/title filter pass. If every other audio track was also filtered out and a commentary track is the only one left, the fallback logic in `Select Streams` still prefers any non-commentary track over a commentary one. It only falls back to keeping a commentary track if literally nothing else survived. See the "Dedupe to exactly one audio track" bullet under [Select Streams, Custom JS Function](README.md#5-select-streams-custom-js-function).

## Operational

### Is it safe to run this against my live library?

Not without a safety net. `Replace Original File` overwrites your source file in place, so any bug in a customized flow can destroy the original. Follow [Confirming a change didn't break anything](README.md#confirming-a-change-didnt-break-anything) before pointing any edited flow at a full library: run it against a small snapshotted batch first, and make sure filesystem snapshots exist before rolling out further. The shipped, unmodified flow has already been validated against real files, but any change you make to it should go through the same check.

### How do I confirm a job actually did what I expected?

Don't trust Tdarr's UI "Preset" preview; it can diverge from the actual dispatched command. Pull the real command from the job report instead:

```bash
sudo grep -n "Running /usr/bin/ffmpeg" <job report>
```

Read it alongside the `--- Select Streams decision table ---` block and the `Plan Encoders` verdict lines in the same report, which show the keep/remove reasoning for every stream. See [Verify with the job report, never the UI preview](README.md#2-verify-with-the-job-report-never-the-ui-preview).

### What happens if a job fails partway through?

Your original file is untouched until the very last node, `Replace Original File`, runs. Everything before it, copying to the working directory, subtitle extraction, stream selection, encoding, happens against a working copy in Tdarr's cache. A failure at any of those earlier stages means the job stops without ever touching the source. One caveat: `Extract SRT Sub` writes its `.eng.srt` sidecar next to the real library file, not the cache copy, so a job that fails after subtitle extraction but before encoding can leave an `.eng.srt` file behind even though the video itself was never modified. That's harmless: the node is idempotent and skips extraction if the sidecar already exists, so a retried job won't redo the work or error out because of it.

### Can I run different encoder settings for different libraries?

Yes. Settings live inside the flow itself (`VIDEO_ARGS` and the audio-handling logic in `Plan Encoders`), not in a global config, so nothing stops you from importing `flow-export-v4.json` more than once, each copy with different settings, and assigning each copy to a different library. See [Running different settings per library](README.md#running-different-settings-per-library) for a worked example (`p4` for a high-volume library, `p7` for a lower-volume one where the extra encode time is worth it).

### How do I change the encoder settings?

Edit the `VIDEO_ARGS` declaration or the audio-handling block near the top of `flow-plugins/plan-encoders.js`, then paste the updated source into the `Plan Encoders` node in Tdarr's UI. There's no second copy of these settings to keep in sync elsewhere. See [Settings used and how to change them](README.md#settings-used-and-how-to-change-them).
