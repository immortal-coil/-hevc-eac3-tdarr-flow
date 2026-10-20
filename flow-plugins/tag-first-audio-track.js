// Custom JS Function node: "Tag first audio track"
// Position: Remove Commentary Tracks -> Tag first audio track -> Reorder Streams
// (must run after Begin Command and after the language/commentary filters,
// and before the single final Execute -- never before a Begin Command reset,
// which wipes args.variables.ffmpegCommand.streams and silently discards
// every removed mark set here).
//
// Dedupes audio down to a single surviving track (e.g. a Remux with a main
// mix + a redundant AC-3 downmix). Falls back to keeping the first audio
// stream if upstream language/commentary filtering stripped every track,
// instead of silently shipping a file with no audio.
module.exports = async (args) => {
  const streams = args.variables.ffmpegCommand.streams;
  let keptAudio = false;
  for (const s of streams) {
    if (s.codec_type !== 'audio' || s.removed) continue;
    if (keptAudio) { s.removed = true; }
    else { keptAudio = true; }
  }
  if (!keptAudio) {
    const first = streams.find((s) => s.codec_type === 'audio');
    if (first) {
      first.removed = false;
      args.jobLog('No eng/und audio survived filtering; keeping first audio track as fallback.');
    }
  }
  return { outputFileObj: args.inputFileObj, outputNumber: 1, variables: args.variables };
};
