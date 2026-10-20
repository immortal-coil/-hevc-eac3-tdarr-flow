// Custom JS Function node: "Select Streams"
// Position: Begin Command -> Select Streams -> Plan Encoders
// Consolidates: Remove Subtitles, Remove Data Streams, Keep Largest Video
// Track, Clean Audio Streams (lang), Remove Commentary Tracks, Tag First
// Audio Track (dedupe + fallback), Reorder Streams.
//
// One pass, flags only. Never writes a file; never clears a `removed` flag
// except in the single, explicitly-logged zero-audio fallback. Must run
// after the flow's ONE Begin Command and before Execute.
//
// Replaces the stock ffmpegCommandRemoveStreamByProperty nodes, whose
// configured `tags:language` / `tags:title` (colon syntax) silently matches
// nothing in current Tdarr (the plugin only supports dot syntax, verified
// against plugin source and thousands of job reports with zero matching
// per-stream log lines). Property access here is native JS, so that
// failure mode no longer exists.
module.exports = async (args) => {
  const streams = args.variables.ffmpegCommand.streams;
  const px = (s) => (s.width && s.height ? s.width * s.height : 0);
  const why = new Map(); // stream -> removal reason, for the decision table
  const mark = (s, reason) => {
    if (!s.removed) { s.removed = true; why.set(s, reason); } // add-only: never resurrects
  };
  const BAD_TITLE = /commentary|description|sdh/i;

  // --- 1. Subtitles (already sidecar'd by Extract SRT Sub) and data streams.
  for (const s of streams) {
    if (s.codec_type === 'subtitle') mark(s, 'subtitle');
    else if (s.codec_type === 'data') mark(s, 'data stream');
  }

  // --- 2. Keep largest video-like stream (embedded cover-art defense).
  // Begin Command relabels disposition.attached_pic streams as
  // codec_type 'attachment', but ffmpeg still encodes them as video at
  // Execute time (NVENC "Frame dimensions" crash, or "Invalid argument" on
  // encoder open for zero-dimension attachments). A real 'video' stream
  // always wins over an 'attachment' one, regardless of pixel count --
  // embedded poster art (e.g. a 2000x3000 mjpeg) can easily out-pixel a
  // real 1920x1080 movie, so pixel count alone is not a safe comparison
  // across the two types. When a real video stream exists, every
  // attachment is removed even if its width/height didn't probe (job
  // ZTgdvBR6V: 14 mjpeg attachments with no probed dimensions all survived
  // filtering and were force-encoded via the global -c:v, killing the
  // whole ffmpeg process). Pixel count only breaks ties within the same
  // type: multiple real video tracks, or (when no real video exists at
  // all) multiple measured attachments. Font attachments carry no
  // width/height and are never touched.
  const realVideo = streams.filter((s) => s.codec_type === 'video' && px(s) > 0);
  const attachments = streams.filter((s) => s.codec_type === 'attachment');
  const measuredAttachments = attachments.filter((s) => px(s) > 0);
  const measured = realVideo.length > 0 ? realVideo : measuredAttachments;
  if (realVideo.length > 0) {
    for (const s of attachments) {
      const dims = s.width ? `${s.width}x${s.height}` : 'unmeasured';
      mark(s, `cover art ${dims} (real video stream present)`);
    }
  }
  if (measured.length > 1) {
    let largest = measured[0];
    for (const s of measured.slice(1)) {
      if (px(s) > px(largest)) largest = s;
    }
    for (const s of measured) {
      if (s !== largest) mark(s, `video ${s.width}x${s.height} < kept ${largest.width}x${largest.height}`);
    }
  }
  // A video-typed stream (not attachment-typed) with missing width/height
  // (broken probe) is deliberately neither compared nor removed -- it can
  // only ever cause an extra copied stream, never the loss of the real
  // movie.

  // --- 3+4. Audio: language filter (keep eng/und; missing tag counts as
  // und) and commentary/description/SDH title filter.
  for (const s of streams) {
    if (s.codec_type !== 'audio') continue;
    const lang = String((s.tags && s.tags.language) || 'und').toLowerCase();
    if (!lang.includes('eng') && !lang.includes('und')) mark(s, `language "${lang}"`);
    const title = (s.tags && s.tags.title) || '';
    if (BAD_TITLE.test(title)) mark(s, `title "${title}"`);
  }

  // --- 5. Dedupe to exactly one audio track, with tiered zero-survivor
  // fallback. This block is the only place in the entire flow allowed to
  // clear a `removed` flag.
  const audio = streams.filter((s) => s.codec_type === 'audio');
  let survivor = audio.find((s) => !s.removed);
  if (!survivor && audio.length > 0) {
    // Nothing survived filtering. Prefer any non-commentary track in any
    // language over a commentary track.
    survivor = audio.find((s) => !BAD_TITLE.test((s.tags && s.tags.title) || '')) || audio[0];
    survivor.removed = false;
    why.delete(survivor);
    args.jobLog(`FALLBACK: no eng/und audio survived filtering; keeping stream #${survivor.index} (${survivor.codec_name}) instead of shipping silent output.`);
  }
  for (const s of audio) {
    if (survivor && s !== survivor) mark(s, 'duplicate audio (one survivor kept)');
  }

  // --- 6. Reorder: video, then audio, then everything else. Execute maps
  // output streams in array order, so a stable sort here is equivalent to
  // the stock Reorder Streams node.
  const rank = (s) => (s.codec_type === 'video' ? 0 : s.codec_type === 'audio' ? 1 : 2);
  streams.sort((a, b) => rank(a) - rank(b)); // Array.sort is stable in Node >= 12

  // --- 7. Decision table: the single job-report artifact that replaces
  // seven nodes' worth of breadcrumbs. Read this before the dispatched
  // ffmpeg command when debugging.
  args.jobLog('--- Select Streams decision table ---');
  for (const s of streams) {
    const dims = s.width ? ` ${s.width}x${s.height}` : '';
    const lang = (s.tags && s.tags.language) || '-';
    const title = (s.tags && s.tags.title) || '';
    const verdict = s.removed ? `REMOVE (${why.get(s) || 'upstream'})` : 'KEEP';
    args.jobLog(`#${s.index} ${s.codec_type}/${s.codec_name}${dims} lang=${lang} title="${title}" -> ${verdict}`);
  }

  return { outputFileObj: args.inputFileObj, outputNumber: 1, variables: args.variables };
};
