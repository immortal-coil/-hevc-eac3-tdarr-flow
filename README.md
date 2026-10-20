---
title: Tdarr Transcode Pipeline
description: A Tdarr Flow that converts a library to HEVC with EAC3 audio, extracts English subtitles as SRT sidecars, and strips unwanted streams in a single encode pass per file.
---

# Tdarr Transcode Pipeline

This is for anyone running Tdarr who wants an HEVC/EAC3 archival transcode that strips junk streams, extracts subtitles as sidecars, and re-encodes in one pass.

## Why this exists

Tdarr's stock stream-manipulation plugins are individually simple, but chaining enough of them to do a correct one-pass transcode is where things go wrong. Several stock plugins have subtle behaviors that silently ship broken output: they judge the raw probed source instead of the streams that survive filtering, they can't see cover-art streams that ffmpeg still encodes as real video, and a stray second `Begin Command` wipes every stream decision made upstream. One stock plugin's property-matching syntax also doesn't match what most configuration examples use, which can no-op an entire filter without any error or log line. Each of those has a specific, reproducible failure mode documented in this file.

Instead of remembering to avoid each failure mode above, you import a flow that has already worked them out.

## What this is and how to use it

There is one thing to import: `flow-export-v4.json`. Load it into Tdarr's Flow editor and you have the whole pipeline. It is a validated flow, tested against real files. This document is reference material for that one flow: what each node does, and why the non-obvious choices are the way they are, so you can understand it, modify it safely, or adapt it.

`flow-export-v4.json` is a 10-node linear flow, no branches. It consolidates the behavior of a much larger predecessor into three Custom JS Function nodes that carry the same correctness, making those failure modes structurally impossible.

The flow works per-library in Tdarr. Assign it to whatever library you want to convert. The version that ships here is built and documented for a standard "re-encode to HEVC" library; the same pattern applies to any other library you want to convert. 4K/UHD sources that are already HEVC stream-copy automatically, no changes needed; see [UHD / copy-only library handling](#uhd--copy-only-library-handling) only if you also want non-HEVC sources left un-re-encoded.

## Contents

- [What you need](#what-you-need)
- [Rules that matter when you modify the flow](#rules-that-matter-when-you-modify-the-flow)
- [Encoder settings](#encoder-settings)
- [Settings used and how to change them](#settings-used-and-how-to-change-them)
- [Node-by-node reference](#node-by-node-reference)
- [Confirming a change didn't break anything](#confirming-a-change-didnt-break-anything)
- [Future enhancements](#future-enhancements)
- [FAQ](FAQ.md)
- [Changelog](CHANGELOG.md)

## What you need

- A Tdarr server. The default profile ("Turbo") needs an NVENC-capable GPU. It was tested against a Blackwell-generation NVIDIA GPU; NVENC's encoder quality and features vary by generation, so older GPUs haven't been verified against the same settings. Without an NVENC GPU, swap in one of the CPU (`libx265`) profiles instead: see [Alternate CPU (libx265) profiles](#alternate-cpu-libx265-profiles).
- This repo:
  - `flow-export-v4.json` is the flow. Import it into Tdarr's Flow editor. This document describes it.
  - `flow-plugins/` holds the source for every Custom JS Function node, matching what's inside the export and what's pasted into the Tdarr UI. Treat these files as canonical; the UI text boxes are the deploy target.
  - `flow-export.json` is the previous 26+ node flow that v4 replaced, kept in-repo for historical reference only. Nothing depends on it, and you don't need it to run the pipeline.

Tdarr identifies flows internally by opaque database IDs that are not visible in the UI and not stable across installs, so this document refers to flows descriptively.

`flow-export-v4.json`'s filename stays fixed at `v4`, the generation of the flow. The `name` field inside the JSON (visible in Tdarr's Flow list after import) carries a minor version, currently `v4.3`, that bumps whenever the flow's live behavior changes: `VIDEO_ARGS`, the audio logic, or the node graph itself. Docs-only edits don't bump it. See [CHANGELOG.md](CHANGELOG.md) for what changed in each version, and re-import the file after pulling an update to pick up the new version in Tdarr.

The flow ships assigned to whatever library you point it at, and works the same on any library. If you maintain several libraries (movies, TV, whatever your split is), assign the same flow to each, or clone it and tune per-library. The one shipped here is the general "re-encode to HEVC" case; the [UHD / copy-only variant](#uhd--copy-only-library-handling) below is the other common case.

### UHD / copy-only library handling

If your UHD/4K sources are already HEVC, the flow as shipped already does the right thing: `Plan Encoders` checks the codec, not the resolution, so a 4K HEVC file stream-copies its video with no re-encode, same as a 1080p HEVC file. You don't need a variant for that case.

The variant below is only for the narrower case: a UHD/4K library where sources are **not** already HEVC (still h264/AVC, say), and you specifically do not want them re-encoded either, whether to preserve the original video quality or because 4K re-encodes are too slow or too expensive to be worth it. You still want all the stream cleanup (subtitle extraction, junk-stream removal, audio dedupe, reorder, EAC3 audio conversion), just none of the video re-encoding.

To build that, keep this flow's `Select Streams` behavior exactly as-is, and swap `Plan Encoders` for a variant that stream-copies video unconditionally: `-c:v copy`, with no HEVC check and no re-encode path at all. Audio handling can stay the same (convert to EAC3 unless already EAC3). The result cleans up streams and normalizes audio while leaving the video bitstream untouched, regardless of source codec.

This is described as a pattern, not a shipped file. There is no exported JSON or separate plugin variant for it in this repo. If you need it, it's a small edit to `plan-encoders.js`: replace the video-encode branch with an unconditional `-c:v copy`.

## Rules that matter when you modify the flow

These are not obvious from the Tdarr UI and each one silently corrupts output if you get it wrong. They matter whenever you edit the flow.

### 1. Only ONE `Begin Command` node in the whole flow

`Begin Command` is Tdarr's `ffmpegCommandStart`. It resets `args.variables.ffmpegCommand.streams` from a fresh ffprobe every time it runs. A second `Begin Command` anywhere on a path silently wipes every upstream `removed` mark and custom stream mutation. The file then falls through to `Execute` with literally every source stream individually mapped, `-map 0:N -c:N copy` for every stream, including all subtitle tracks. v4's linear shape makes this easy to keep right: there is exactly one `Begin Command`, and both `Select Streams` and `Plan Encoders` mutate the stream array downstream of it. Never place either of those custom nodes upstream of `Begin Command`.

### 2. Verify with the job report, never the UI preview

Tdarr's "Preset" preview in the UI and the actual runtime-rendered command can diverge. The only ground truth for whether a change took effect is the dispatched command in the job report:

```bash
sudo grep -n "Running /usr/bin/ffmpeg" <job report>
```

Use this after every change. The flow additionally logs a full per-stream decision table from `Select Streams` and per-stream encoder verdicts from `Plan Encoders` into the same job report, so read those alongside the dispatched command when debugging.

### 3. Custom Arguments fields are NOT shell-parsed

A double-quoted filter value like `-af "aformat=..."` in a Custom Arguments or classic-plugin `arguments` field gets passed to ffmpeg as literal characters, breaking the filter name with `No such filter: '"aformat'`. Use no outer quotes in these fields. Inner single-quotes inside a `scale=` filter expression are fine, since that is ffmpeg's own filter-syntax escaping, not shell quoting.

The flow sidesteps this trap in `Plan Encoders`: it pushes each argument as a pre-tokenized array element onto `overallOuputArguments` / `overallInputArguments`, so there is no free-text field to mis-quote. The trap still applies to any stock custom-args node you add by hand.

## Encoder settings

The default profile, called "Turbo", was validated with a VMAF (Video Multi-method Assessment Fusion, a perceptual video-quality metric) sweep. The video side lives entirely inside `Plan Encoders` as the `VIDEO_ARGS` declaration. The audio side is channel-count-aware rather than a single fixed argument list; see below.

```text
-c:v hevc_nvenc -pix_fmt p010le -preset p4 -rc vbr -cq 31 -temporal-aq 1 -multipass qres -bf 4
```

What each video option does:

- `-c:v hevc_nvenc`: encode video with NVIDIA's NVENC HEVC hardware encoder, not a CPU codec.
- `-pix_fmt p010le`: 10-bit output in NVENC's native pixel layout (see the note below on why not `yuv420p10le`).
- `-preset p4`: NVENC's mid-range speed/quality preset (`p1` fastest/lowest quality through `p7` slowest/highest quality). `p4` is the shipped default. Raising it toward `p7` trades encode speed for a small quality gain: a mean +0.14 VMAF for a mean 2.7x longer encode time. That's measured across 20 real clips and episodes in the VMAF sweep linked under [Settings used and how to change them](#settings-used-and-how-to-change-them). Only move off `p4` if that trade is worth it for your hardware.
- `-rc vbr`: variable bitrate rate control, so bitrate can flex per-scene instead of being pinned to a fixed target.
- `-cq 31`: the constant-quality target for `vbr` mode; a fixed perceptual-quality level rather than a fixed output size (lower number is higher quality/bigger file).
- `-temporal-aq 1`: enables temporal adaptive quantization, which shifts bits toward frames/regions that need them across time (helps motion and low-detail scenes hold up better).
- `-multipass qres`: NVENC's quarter-resolution multipass mode, a fast internal lookahead pass that improves rate-control decisions before the real encode.
- `-bf 4`: allow up to 4 consecutive B-frames, improving compression efficiency at the cost of a small amount of extra encoder complexity.

Audio always encodes to `-c:a eac3`, Enhanced AC-3 (EAC3/DD+), but the channel layout and bitrate track the source instead of being forced to one fixed value:

- A source with more than 6 channels (7.1, which ffprobe reports as 8 channels) gets downmixed with `-af aformat=channel_layouts=5.1 -b:a 384k`. Channel count only ever goes down, never up.
- A source with 6 or fewer channels keeps its original channel count and layout (no `-af` at all, so ffmpeg passes the source layout through to the encoder), at `-b:a 192k` for 2 channels or fewer and `-b:a 384k` for 3 to 6 channels.

This avoids upmixing, for example turning a 2.0 stereo AC3 track into a synthesized 5.1 track. Forcing 5.1 unconditionally used to inflate stereo sources for channels that were never in the source: job `IoZG9j9G0` took a 192 kbps stereo AC3 track to a 384 kbps 5.1 EAC3 track, growing the whole file by 7.9% for four invented channels.

Notes:

- Use `p010le`, not `yuv420p10le`. Both are 10-bit, but `p010le` is NVENC's native layout. The other triggers a harmless auto-substitute warning on every job.
- CQ mode targets fixed perceptual quality, not fixed size. Small or already-efficient sources such as WEBDLs and prior Bluray rips can grow under this profile. That is expected, not a bug. Percent reduction isn't a stable way to describe this profile's output, since it depends entirely on how compressed the source already was. A steadier number, pulled from real production jobs: encoding a 1080p Blu-ray Remux (the case this profile is tuned for) with Turbo produces a file in the roughly 1.0-2.6GB range, averaging around 1.5GB (median ~1.4GB).
- `--colorspace bt709` from the original HandBrake command was deliberately dropped when porting to ffmpeg. In HandBrake it invokes a real tonemap-capable filter, not just metadata tagging, and it was never validated.

`Plan Encoders` also carries commented-out alternate CPU (`libx265`) profiles inline in the source, "Movie Baseline", "Max Savings", and "TV", each a drop-in replacement for the `VIDEO_ARGS` line if you want to trade NVENC speed for CPU-encode efficiency. The disconnected `comment` node in the graph points at these same comments.

## Settings used and how to change them

Every video encoder setting lives in one place: the `VIDEO_ARGS` declaration near the top of `flow-plugins/plan-encoders.js`. There's no UI field to hunt through and no second copy to keep in sync: edit the array, paste the updated source into the `Plan Encoders` node in Tdarr, and every job picks up the change. The audio side is a small block of channel-aware logic further down the same file rather than a single constant, since the bitrate and channel layout depend on the surviving audio stream's own channel count.

```javascript
// Validated "Turbo" profile (VMAF-swept). Alternate encoder profiles for
// experiments live in the README.
const VIDEO_ARGS = ['-c:v', 'hevc_nvenc', '-pix_fmt', 'p010le', '-preset', 'p4',
  '-rc', 'vbr', '-cq', '31', '-temporal-aq', '1', '-multipass', 'qres', '-bf', '4'];
```

This is the "Turbo" profile: NVENC hardware encode, tuned for speed without giving up much quality. It's the one actually wired in and shipped in `flow-export-v4.json`. It was chosen after a VMAF sweep against CPU (`libx265`) alternatives. Across 19 valid sources, NVENC held the same VMAF as the CPU baseline at a mean 3.1x faster encode time (range 1.7x-9.0x). Sweep tooling, methodology, and full per-source results: [immortal-coil/vmaf](https://github.com/immortal-coil/vmaf).

### Alternate CPU (libx265) profiles

`plan-encoders.js` also carries three alternate profiles, commented out inline in the source, right above the live `VIDEO_ARGS` declaration. All three were part of the same VMAF sweep as Turbo. None of these are wired in: they're drop-in replacements for the `VIDEO_ARGS` line if you want to trade NVENC's speed for `libx265`'s better compression efficiency per bit, at the cost of much slower CPU-bound encoding.

**Movie Baseline:**

```javascript
const VIDEO_ARGS = ['-c:v', 'libx265', '-pix_fmt', 'yuv420p10le', '-preset', 'medium', '-crf', '25',
  '-x265-params', 'colorprim=bt709:transfer=bt709:colormatrix=bt709'];
```

**Max Savings:**

```javascript
const VIDEO_ARGS = ['-c:v', 'libx265', '-pix_fmt', 'yuv420p10le', '-preset', 'slow', '-crf', '27',
  '-x265-params', 'colorprim=bt709:transfer=bt709:colormatrix=bt709'];
```

**TV:**

```javascript
const VIDEO_ARGS = ['-c:v', 'libx265', '-pix_fmt', 'yuv420p10le', '-preset', 'medium', '-crf', '25',
  '-x265-params', 'colorprim=bt709:transfer=bt709:colormatrix=bt709:aq-mode=2:aq-strength=0.8:psy-rd=1.0'];
```

To switch to one of these, replace the live `VIDEO_ARGS` line with the profile you want and redeploy the node source. The audio logic is independent of the video profile and doesn't need to change.

- **Movie Baseline** and **Max Savings** share the same `bt709` color params, and only differ in `-preset`/`-crf`: Max Savings trades a slower preset and a higher CRF for smaller files at roughly equivalent perceptual quality, at the cost of much longer encode times.
- **TV** starts from Movie Baseline's settings and adds `x265` psychovisual tuning (`aq-mode=2:aq-strength=0.8:psy-rd=1.0`), aimed at grain- and noise-heavy sources more common in TV sources than in film masters.
- All four profiles, Turbo included, were evaluated in the same VMAF sweep; Turbo was the one selected for the shipped flow.

### Running different settings per library

Settings live in the flow, not in a global config, so nothing stops you from running more than one copy of this flow with different `VIDEO_ARGS`, each assigned to a different library. This is a reasonable way to use the `p4`/`p7` tradeoff from above instead of picking one preset for everything: assign a `p4` copy to a high-volume, lower-priority library (TV, say), and a `p7` copy to a lower-volume library where the extra encode time is worth the small quality bump (Remuxes, for example). Same idea applies to swapping in one of the CPU (`libx265`) profiles for a specific library while others stay on NVENC. Each copy is just `flow-export-v4.json` re-imported with a different `Plan Encoders` source, assigned to its own library.

## Node-by-node reference

The flow:

```text
Input File -> Copy to Working Directory -> Extract SRT Sub -> Begin Command
  -> Select Streams -> Plan Encoders -> Set MKV Container -> Execute: Encoding
  -> Replace Original File -> Notify Plex
```

Importing `flow-export-v4.json` also brings in one node you can ignore: a disconnected `comment` node off to the side ("See comments in Plan Encoders to change ffmpeg encoding settings. CPU Baseline, Max Savings, TV, and NVENC (default) are already included."). Tdarr's comment plugin type is a no-op regardless of how it's wired; it exists purely as in-UI documentation and does not affect the running command.

The design principle: all stream selection and removal happens as in-memory mutations on `args.variables.ffmpegCommand.streams` before a single `Execute` pass. Each stream entry carries a `removed` flag. Nodes set flags, and only `Execute` writes a file. The whole thing is two Custom JS Function nodes (`Select Streams`, `Plan Encoders`) with no branches at all: this replaced a predecessor flow that spread the same work across seven stock/custom stream nodes plus a four-node encode branch.

Nodes:

1. [Input File](#1-input-file)
2. [Copy to Working Directory](#2-copy-to-working-directory)
3. [Extract SRT Sub, Custom JS Function](#3-extract-srt-sub-custom-js-function)
4. [Begin Command](#4-begin-command)
5. [Select Streams, Custom JS Function](#5-select-streams-custom-js-function)
6. [Plan Encoders, Custom JS Function](#6-plan-encoders-custom-js-function)
7. [Set MKV Container](#7-set-mkv-container)
8. [Execute: Encoding](#8-execute-encoding)
9. [Replace Original File](#9-replace-original-file)
10. [Notify Plex](#10-notify-plex)

### 1. Input File

Stock entry node. The flow's starting point; no settings.

### 2. Copy to Working Directory

Stock node, no special settings. Copies the file into Tdarr's cache/working directory before any transcode work touches it. Everything downstream reads from this local copy rather than the source over the network share.

### 3. Extract SRT Sub, Custom JS Function

Source: `flow-plugins/extract-srt-sub.js`. Runs after `Copy to Working Directory` so ffmpeg reads the local cache copy (`args.inputFileObj._id`) instead of the source over the network share, which is faster on a slow NFS/SMB link. The `.eng.srt` sidecar still lands next to the real library file: the output path is always derived from `args.originalLibraryFile._id`, which stays stable regardless of where this node sits in the flow. Moving this node after the copy changes only where ffmpeg reads from, not where the `.srt` ends up. It runs its own ffmpeg subprocess and never touches `args.variables.ffmpegCommand`, so it adds no pass to the main pipeline.

Behavior worth knowing before you trust it:

- Picks the first eligible English subtitle stream, preferring tracks that are neither hearing-impaired nor forced.
- Skips bitmap-only formats that cannot convert to text SRT without OCR: `hdmv_pgs_subtitle`, `dvd_subtitle`, `dvb_subtitle`, `dvb_teletext`, and `xsub`.
- Skips commentary and description titled tracks.
- Idempotent via skip-if-exists on the `.eng.srt` path.
- Guards against missing `ffProbeData`, which would otherwise throw and stall the job.
- Deletes a partial `.eng.srt` on ffmpeg failure. Without this, the skip-if-exists check would see the stuck partial file and skip forever on every retry.
- Uses a 10-minute `execFile` timeout so a stalled read cannot hang a job indefinitely.
- Leave this node's `err1` output unwired. An unhandled error output just stops the job normally; routing it into a comment node instead makes failures silently dead-end.

### 4. Begin Command

Stock `ffmpegCommandStart` node. This is the only one in the entire flow. See rule 1 above. Do not add another anywhere, and do not move `Select Streams` or `Plan Encoders` in front of it, which would wipe their work.

### 5. Select Streams, Custom JS Function

Source: `flow-plugins/select-streams.js`. This single node does the work of seven predecessor nodes (Remove Subtitles, Remove Data Streams, Keep Largest Video Track, Clean Audio Streams (language filter), Remove Commentary Tracks, Tag First Audio Track (dedupe + zero-audio fallback), and Reorder Streams) in one pass over the stream array. It runs after the flow's one `Begin Command` and before `Execute`. It sets flags only; it never writes a file, and it never clears a `removed` flag except in the single, explicitly-logged zero-audio fallback.

What it does, in order, and the lessons baked into each part:

- **Subtitles and data streams.** Marks every subtitle and data stream removed. English subs were already saved as a sidecar in step 3.

- **Keep the largest real video stream, cover-art defense.** This is the fix for a real production failure. Blu-ray Remuxes commonly embed cover art (mjpeg poster thumbnails) as extra streams. Two things make this dangerous rather than cosmetic. First, the stock `Remove Data Streams` node can't catch them, since it only filters `codec_type: data`. Second, and less obvious, `Begin Command` relabels `disposition.attached_pic` streams as `codec_type: "attachment"`, not `"video"`, so a naive property filter scoped to `codecType: video` silently matches nothing. ffmpeg itself still encodes them as real video at `Execute` time, so the global `-c:v hevc_nvenc` gets applied to a tiny thumbnail and NVENC fails with `Frame dimensions are less than the minimum supported value`. `Select Streams` handles this by type first, then pixels: a real `video` stream always wins over an `attachment`, regardless of pixel count, because embedded poster art (say a 2000x3000 mjpeg) can out-pixel a real 1920x1080 movie, so pixel count alone is not safe across the two types. Pixel count only breaks ties within the same type. Font attachments carry no width/height and are never touched. A `video`-typed stream with a broken probe (missing width/height) is deliberately neither compared nor removed, so it can only ever cause an extra copied stream, never the loss of the real movie.

- **Audio language filter.** Keeps `eng` and `und` (a missing language tag counts as `und`), marks everything else removed. This is where the predecessor flow's most insidious bug lived. The stock `ffmpegCommandRemoveStreamByProperty` plugin only supports dot notation for nested properties (`tags.language`), not the colon notation (`tags:language`) every version of the old flow was configured with. The plugin treated colon syntax as an unrecognized property and skipped without logging, so language and commentary filtering did nothing on the live flow for a long time; it worked by luck because track 0 was usually the right one. `Select Streams` reads properties with native JS (`s.tags.language`), so that failure mode is structurally impossible here. Note the old flow also had to scope this to `codecType: audio` because an `any` scope would remove a non-eng-tagged video stream and ship an audio-only file; the native code sidesteps that too by only ever touching `codec_type === 'audio'` streams.

- **Commentary/description/SDH title filter.** Marks audio tracks whose title matches `/commentary|description|sdh/i` removed. The old flow shipped a `desciption` typo (missing an r) that let audio-description tracks through and sometimes made them the kept track; a case-insensitive regex against the whole word class removes that mistake.

- **Dedupe to exactly one audio track, with a tiered zero-survivor fallback.** Keeps whichever eng/und, non-commentary audio stream survives first in stream order. This is the only place in the flow allowed to clear a `removed` flag: if filtering stripped every audio track (for example a file whose only audio is a foreign-language track), it prefers any non-commentary track in any language over a commentary track, un-removes it, and logs a `FALLBACK:` line, rather than shipping silent output or an ffmpeg failure. The dedupe does not compare bitrate, channel count, or codec; it trusts stream order, which is right on most sources but not guaranteed.

- **Reorder: video, then audio, then everything else.** A stable sort by codec type. `Execute` maps output streams in array order, so this is equivalent to the old stock Reorder Streams node.

- **Decision table.** The node logs one `--- Select Streams decision table ---` block to the job report, one line per stream with its keep/remove verdict and reason. This single artifact replaces seven nodes' worth of breadcrumbs; read it before the dispatched ffmpeg command when debugging.

### 6. Plan Encoders, Custom JS Function

Source: `flow-plugins/plan-encoders.js`. This node does the work of the predecessor flow's entire four-node encode branch (Check if Video is HEVC, NVENC Encoder, Check if audio is EAC3, and Encode AC3, plus all four branch combinations) in one straight-line node with no branches. It runs after `Select Streams` and before `Set MKV Container`. Because `Select Streams` guarantees at most one surviving video and one surviving audio stream, global `-c:v` / `-c:a` semantics are safe.

The core correctness point: `Plan Encoders` judges the surviving streams (post-filter, post-dedupe, post-fallback), not the raw probe. This fixes two stock-plugin bugs at once. Stock `checkVideoCodec` and stock `checkAudioCodec` both match any stream in the whole probed source. A file with a DTS main track plus an EAC3 commentary track (stripped upstream) would report "already EAC3", skip conversion, and ship DTS. Judging the survivor is the whole reason this is a custom node.

Video handling:

- If the surviving video is already `hevc`, it stream-copies and logs it, no re-encode.
- If the only video-like survivor is a cover-art image (`mjpeg`/`png`/`bmp`/`gif`, or an `attachment`), it throws loudly rather than letting NVENC crash on a broken source. That is the belt-and-suspenders partner to the cover-art defense in `Select Streams`.
- Otherwise it pushes the Turbo `VIDEO_ARGS` onto the output and adds `-hwaccel cuda` on the input side.

The CUDA decode addition is a scarred-in choice. `-hwaccel cuda` auto-picks the matching CUVID decoder (`h264_cuvid`, `hevc_cuvid`, `av1_cuvid`, etc.) for whatever the input is, so one flag covers every codec with no per-source branching. It is only added on the re-encode path; a stream-copy job never decodes video, so hwaccel would be a no-op there. It is NOT paired with `-hwaccel_output_format cuda`. That flag keeps decoded frames as GPU-resident CUDA surfaces, but `VIDEO_ARGS` requests `-pix_fmt p010le` as a plain output option, and converting a CUDA surface to p010le needs an explicit `scale_cuda`/`hwdownload` filter, not a bare `-pix_fmt`. Adding it caused `Error reinitializing filters!` in production (job `HxtrklhRCZ` and three others, all h264 WEBDL TV sources). Plain `-hwaccel cuda` still gets NVDEC hardware decode; frames just come back to system memory afterward, so the existing p010le path is unaffected.

Audio handling:

- If the surviving audio is already `eac3` at 6 channels or fewer, it stream-copies and logs it, preserving Atmos-in-EAC3 metadata. This is what protects against the old bug where wiring NVENC straight to the AC3 encoder force-re-encoded already-EAC3 audio, causing generation loss plus a forced 5.1 re-layout that strips Atmos metadata or upmixes stereo.
- If the surviving audio has more than 6 channels (7.1, which ffprobe reports as 8 channels), regardless of its source codec including `eac3`, it downmixes with `-af aformat=channel_layouts=5.1 -c:a eac3 -b:a 384k`.
- Otherwise (any non-`eac3` codec at 6 channels or fewer) it re-encodes to `eac3` at the source's own channel count, no `-af` at all, at `-b:a 192k` for 2 channels or fewer or `-b:a 384k` for 3 to 6 channels. Channel count only ever goes down, never up: a 2.0 stereo AC3 track stays 2.0, it does not get synthesized into 5.1.
- If there is no surviving audio at all, it logs a video-only output and moves on.

No manual `-map` anywhere in this node. `Begin Command` already maps the streams, and ffmpeg's `-map` is additive; a stray `-map 0:1` once produced two identical output audio streams on a real VC-1 source. Stream selection is controlled entirely by `stream.removed` plus these output args. Because the args are pushed as pre-tokenized array elements onto `overallOuputArguments` / `overallInputArguments`, rule 3's shell-quoting trap cannot occur here.

### 7. Set MKV Container

Stock node, output container MKV. Feeds `Execute: Encoding`.

Put this last, right before `Execute`, not earlier in the chain. Its `forceConform` behavior evaluates whatever streams are in the array at the moment it runs; running it early means it judges the initial probed set, before `Select Streams` has finished mutating `removed` flags. Running it last means it judges the actual final stream set that `Execute` will act on.

### 8. Execute: Encoding

The single real ffmpeg pass. It just runs whatever is currently built up in `args.variables.ffmpegCommand.streams` and the accumulated input/output args; with no branches there is only one path into it.

### 9. Replace Original File

Stock node: replaces the source with the transcoded output. There is no separate rename step; this handles the swap. Because it overwrites the library file in place, this is the node that makes the [verification checks](#confirming-a-change-didnt-break-anything) matter whenever you edit the flow.

### 10. Notify Plex

This node is optional. It uses the classic plugin `Tdarr_Plugin_TD01_TOAD_Autoscan` (`runClassicTranscodePlugin`) to notify Plex and trigger a library autoscan so the new file is picked up. It requires [Autoscan](https://github.com/Cloudbox/autoscan) running and reachable, and expects `autoscan_username` and `autoscan_address` set in its inputs. If you don't run Autoscan, remove this node (or point `Replace Original File` straight to the end of the flow) and rely on Plex's own library-scan schedule instead.

## Confirming a change didn't break anything

Because this flow replaces original files in place, treat every edit as production-risky. These steps are how you confirm a future edit didn't regress it, on a small snapshotted batch, before rolling the edit out to the whole library.

1. Run a job, then pull the dispatched command from its report:

   ```bash
   sudo grep -n "Running /usr/bin/ffmpeg" <job report>
   ```

   Confirm the command shows only the streams you expect. A command mapping every source stream with `-c:N copy`, subtitles included, means a stray `Begin Command` is resetting state. See rule 1.

2. Read the `--- Select Streams decision table ---` block and the `Plan Encoders` verdict lines in the same report. Confirm the kept video and audio streams, and the removal reasons, are what you intended before trusting the dispatched command.

3. Exercise the codec combinations with real files: HEVC-with-EAC3 (full stream-copy), HEVC-without-EAC3, non-HEVC-with-EAC3, and non-HEVC-without-EAC3 (full re-encode). There are no branches, but these are still the four state combinations `Plan Encoders` decides between.

4. Confirm the `.eng.srt` sidecar appears next to the source in the library path, not in the cache directory.

5. Because `Replace Original File` overwrites in place, run any edit on a small snapshotted batch first, and make sure filesystem snapshots exist before pointing the changed flow at the full library.

Expect one class of harmless log noise: `-c:0 copy` gets set by `Begin Command`'s default per-stream fallback and then overridden by the global `-c:v hevc_nvenc`. ffmpeg's last-option-wins behavior makes duplicate codec options cosmetic.

## Future enhancements

- HDR to SDR tonemap for sources that already need a video re-encode. HDR isn't tied to resolution or library (a 1080p source can carry HDR10 metadata too), so detection has to read the stream's own `color_transfer`/`color_primaries`, not the library name. Scope is deliberately narrow: only sources already on the re-encode path in `Plan Encoders` get tonemapped. Sources that are already HEVC, HDR or not, keep stream-copying as-is; forcing a re-encode just to strip HDR off an otherwise-fine file isn't worth it.
