// Custom JS Function node: "Extract SRT Sub"
// Position: Input File -> Copy to Working Directory -> Extract SRT Sub -> Begin Command
// Runs after Copy to Working Directory so ffmpeg reads the local cache
// copy (args.inputFileObj._id) instead of the source over the network
// share -- faster on a slow NFS/SMB link. The sidecar still gets written
// next to the real library file: the OUTPUT path is always derived from
// args.originalLibraryFile._id, which stays stable regardless of node
// position, so moving this node after the copy changes only where ffmpeg
// reads from, not where the .srt ends up.
//
// Extracts the first eligible English subtitle stream to a <basename>.eng.srt
// sidecar next to the source file. Pure side effect via its own ffmpeg
// subprocess -- does not touch args.variables.ffmpegCommand, so it has zero
// effect on the main transcode pipeline's pass count.
module.exports = async (args) => {
  const { execFile } = require('child_process');
  const fs = require('fs');

  const readPath = args.inputFileObj._id;
  const libraryPath = args.originalLibraryFile._id;
  const ffmpegPath = args.ffmpegPath || '/usr/bin/ffmpeg';

  const streams = args.inputFileObj?.ffProbeData?.streams || [];
  const engSubs = streams.filter((s) =>
    s.codec_type === 'subtitle'
    && s.tags?.language === 'eng'
    && !['hdmv_pgs_subtitle', 'dvd_subtitle', 'dvb_subtitle', 'dvb_teletext', 'xsub'].includes(s.codec_name)
    && !/commentary|description/i.test(s.tags?.title || ''));

  if (engSubs.length === 0) {
    args.jobLog('No eligible English subtitle track found.');
    return { outputFileObj: args.inputFileObj, outputNumber: 1, variables: args.variables };
  }

  const chosen = engSubs.find((s) => !s.disposition?.hearing_impaired && !s.disposition?.forced) || engSubs[0];
  const outPath = libraryPath.replace(/\.[^/.]+$/, '') + '.eng.srt';

  if (fs.existsSync(outPath)) {
    args.jobLog('eng.srt already exists, skipping: ' + outPath);
    return { outputFileObj: args.inputFileObj, outputNumber: 1, variables: args.variables };
  }

  await new Promise((resolve) => {
    execFile(ffmpegPath, ['-y', '-i', readPath, '-map', `0:${chosen.index}`, outPath],
      { maxBuffer: 1024 * 1024 * 20, timeout: 600000 }, (err, stdout, stderr) => {
        if (err) {
          args.jobLog('Subtitle extraction failed: ' + stderr);
          try { fs.unlinkSync(outPath); } catch (e) { /* nothing to clean up */ }
        } else {
          args.jobLog('Extracted ' + outPath);
        }
        resolve();
      });
  });

  return { outputFileObj: args.inputFileObj, outputNumber: 1, variables: args.variables };
};
