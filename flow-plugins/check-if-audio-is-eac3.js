// Custom JS Function node: "Check if audio is EAC3"
// Replaces the stock "Check Audio Codec" node (checkAudioCodec), which
// inspects whether ANY stream in the whole probed source is EAC3 --
// wrong when the surviving track after language/commentary/dedupe
// filtering isn't the one that happened to be EAC3 (e.g. a DTS main
// track plus an EAC3 commentary track that gets stripped upstream would
// wrongly report "already EAC3" and skip conversion, leaving DTS in the
// final output).
//
// Position: fed by both "Check if Video is HEVC" [1] (already-HEVC branch)
// and "NVENC Encoder" [1] (needs-transcode branch), so both converge here
// regardless of whether video was re-encoded.
// Output 1 (true)  -> Execute (audio already EAC3, stream-copy)
// Output 2 (false) -> Encode AC3 -> Execute (needs audio transcode)
module.exports = async (args) => {
  const streams = args.variables.ffmpegCommand.streams;
  const survivor = streams.find((s) => s.codec_type === 'audio' && !s.removed);
  const isEac3 = !!survivor && survivor.codec_name === 'eac3';
  return { outputFileObj: args.inputFileObj, outputNumber: isEac3 ? 1 : 2, variables: args.variables };
};
