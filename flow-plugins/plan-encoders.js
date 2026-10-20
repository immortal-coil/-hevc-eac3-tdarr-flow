// Custom JS Function node: "Plan Encoders"
// Position: Select Streams -> Plan Encoders -> Set MKV Container -> Execute
// Consolidates: Check if Video is HEVC, NVENC Turbo Encoder, Check if audio
// is EAC3, Encode AC3 -- and all four branch combinations, with no branches.
//
// Judges the SURVIVING streams (post-filter, post-dedupe, post-fallback),
// fixing two stock-plugin bugs at once: stock checkAudioCodec and stock
// checkVideoCodec both match ANY stream in the raw probe, not the stream
// that actually ships.
//
// Args are pushed as pre-tokenized array elements onto
// overallOuputArguments (Tdarr's own field name), so custom-args fields'
// "no shell quoting" trap is structurally impossible here. Global -c:v/-c:a
// semantics are safe because Select Streams guarantees at most one
// surviving video and one surviving audio stream.
module.exports = async (args) => {
  const cmd = args.variables.ffmpegCommand;
  const out = cmd.overallOuputArguments;
  const inp = cmd.overallInputArguments;
  const survivors = cmd.streams.filter((s) => !s.removed);

  // Alternate CPU (libx265) encoder profiles, not currently wired in.
  // Each is a drop-in replacement for the VIDEO_ARGS declaration below,
  // to trade NVENC speed for CPU-encode efficiency.
  //
  // Movie Baseline:
  //   const VIDEO_ARGS = ['-c:v', 'libx265', '-pix_fmt', 'yuv420p10le', '-preset', 'medium', '-crf', '25',
  //     '-x265-params', 'colorprim=bt709:transfer=bt709:colormatrix=bt709'];
  //
  // Max Savings:
  //   const VIDEO_ARGS = ['-c:v', 'libx265', '-pix_fmt', 'yuv420p10le', '-preset', 'slow', '-crf', '27',
  //     '-x265-params', 'colorprim=bt709:transfer=bt709:colormatrix=bt709'];
  //
  // TV:
  //   const VIDEO_ARGS = ['-c:v', 'libx265', '-pix_fmt', 'yuv420p10le', '-preset', 'medium', '-crf', '25',
  //     '-x265-params', 'colorprim=bt709:transfer=bt709:colormatrix=bt709:aq-mode=2:aq-strength=0.8:psy-rd=1.0'];
  //
  // Validated "Turbo" profile (VMAF-swept). Alternate encoder profiles for
  // experiments live in the README.
  const VIDEO_ARGS = ['-c:v', 'hevc_nvenc', '-pix_fmt', 'p010le', '-preset', 'p4',
    '-rc', 'vbr', '-cq', '31', '-temporal-aq', '1', '-multipass', 'qres', '-bf', '4'];

  // Video: judge the survivor, not the whole probe. codec_type may be
  // 'attachment' if the only video-like stream was an un-competed cover art
  // image -- that is a broken source for a movie library, so fail loudly
  // here instead of letting NVENC crash with "Frame dimensions are less
  // than the minimum supported value".
  const video = survivors.find((s) => s.codec_type === 'video')
    || survivors.find((s) => s.codec_type === 'attachment' && s.width && s.height);
  if (!video) throw new Error('Plan Encoders: no surviving video stream after Select Streams.');
  const isImage = ['mjpeg', 'png', 'bmp', 'gif'].includes(video.codec_name)
    || String(video.codec_long_name || '').includes('image');
  if (video.codec_name === 'hevc') {
    args.jobLog(`video #${video.index} already hevc -> stream copy`);
  } else if (isImage) {
    throw new Error(`Plan Encoders: only video-like survivor #${video.index} is ${video.codec_name} cover art (${video.width}x${video.height}); no real movie stream in source.`);
  } else {
    // Hardware decode the source too, not just encode. -hwaccel cuda
    // auto-picks the matching CUVID decoder (h264_cuvid, hevc_cuvid,
    // av1_cuvid, etc.) for whatever the input actually is, so this one
    // flag covers every codec without per-source branching. Only added
    // when a real re-encode is happening -- a stream-copy job never
    // decodes the video, so hwaccel would be a no-op there anyway.
    //
    // Deliberately NOT adding -hwaccel_output_format cuda. That keeps
    // decoded frames as GPU-resident CUDA surfaces, but VIDEO_ARGS
    // requests -pix_fmt p010le as a plain output option -- converting a
    // CUDA surface to p010le needs an explicit scale_cuda/hwdownload
    // filter, not a bare -pix_fmt, and ffmpeg's auto filter-graph
    // negotiation breaks on that mismatch ("Error reinitializing
    // filters!", confirmed in production on job HxtrklhRCZ). Plain
    // -hwaccel cuda still gets NVDEC hardware decode; frames just come
    // back to system memory afterward, so the existing p010le path is
    // unaffected.
    inp.push('-hwaccel', 'cuda');
    out.push(...VIDEO_ARGS);
    args.jobLog(`video #${video.index} ${video.codec_name} -> hevc_nvenc (Turbo p4/cq31), hw decode via cuda`);
  }

  // Audio: judge the one survivor Select Streams guarantees. Channel count
  // only ever goes down, never up: a 2.0 source stays 2.0, and only a
  // source above 5.1 (7.1 = 8ch) gets downmixed to 5.1. Forcing everything
  // to 5.1/384k used to synthesize channels that were never in the source
  // (job IoZG9j9G0: 192k stereo AC3 -> 384k 5.1 EAC3, +7.9% file size for
  // four channels ffmpeg had to invent).
  const audio = survivors.find((s) => s.codec_type === 'audio');
  if (audio) {
    const srcChannels = audio.channels || 6;
    if (audio.codec_name === 'eac3' && srcChannels <= 6) {
      args.jobLog(`audio #${audio.index} already eac3, ${srcChannels}ch -> stream copy (Atmos-in-EAC3 metadata preserved)`);
    } else if (srcChannels > 6) {
      out.push('-af', 'aformat=channel_layouts=5.1', '-c:a', 'eac3', '-b:a', '384k');
      args.jobLog(`audio #${audio.index} ${audio.codec_name} ${srcChannels}ch -> eac3 5.1 384k (downmixed)`);
    } else {
      const bitrate = srcChannels <= 2 ? '192k' : '384k';
      out.push('-c:a', 'eac3', '-b:a', bitrate);
      args.jobLog(`audio #${audio.index} ${audio.codec_name} ${srcChannels}ch -> eac3 ${srcChannels}ch ${bitrate} (channel count preserved)`);
    }
  } else {
    args.jobLog('no audio stream in source; video-only output.');
  }

  return { outputFileObj: args.inputFileObj, outputNumber: 1, variables: args.variables };
};
