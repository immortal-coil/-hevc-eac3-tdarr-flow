// Custom JS Function node: "Keep largest video track"
// Position: after Remove Data Streams, before Clean Audio Streams
// (same slot as the stock per-property removal nodes; must run after
// Begin Command and before the single final Execute).
//
// Keeps the real video stream and marks every embedded cover-art
// "attachment" stream (mjpeg posters/thumbnails, reported by Tdarr as
// codec_type: "attachment" rather than "video") removed. A real
// codec_type: "video" stream always wins over an "attachment" one,
// regardless of pixel count -- embedded poster art can be higher
// resolution than the actual movie (e.g. a 2000x3000 mjpeg cover next to
// a 1920x1080 source), so pixel count alone is not a safe comparison
// across the two types. Pixel count only breaks ties within the same
// type: multiple real video tracks, or (when no real video exists at
// all) multiple attachments.
module.exports = async (args) => {
  const streams = args.variables.ffmpegCommand.streams;
  const pixelCount = (s) => (s.width && s.height) ? s.width * s.height : 0;

  const realVideo = streams.filter((s) => s.codec_type === 'video' && pixelCount(s) > 0);
  const attachments = streams.filter((s) => s.codec_type === 'attachment' && pixelCount(s) > 0);
  // Font attachments carry no width/height and are excluded by the
  // pixelCount(s) > 0 checks above, so they're never touched.
  const videoStreams = realVideo.length > 0 ? realVideo : attachments;

  if (realVideo.length > 0) {
    for (const s of attachments) { s.removed = true; }
  }

  if (videoStreams.length > 1) {
    let largest = videoStreams[0];
    for (const s of videoStreams.slice(1)) {
      if (pixelCount(s) > pixelCount(largest)) largest = s;
    }
    const smaller = videoStreams.filter((s) => s !== largest);
    // Only ever add removals, never clear one a prior node already set.
    for (const s of smaller) { s.removed = true; }
    args.jobLog(`Kept video stream ${largest.index} (${largest.width}x${largest.height}), removed ${smaller.length} smaller video stream(s).`);
  } else if (attachments.length > 0 && realVideo.length > 0) {
    args.jobLog(`Kept real video stream, removed ${attachments.length} cover-art attachment stream(s).`);
  }

  return { outputFileObj: args.inputFileObj, outputNumber: 1, variables: args.variables };
};
