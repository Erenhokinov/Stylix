{
  pkgs,
  wayvibesSoundpackSource,
}:
pkgs.runCommand "wayvibes-akko-lavender-purples-wav" {
  nativeBuildInputs = [pkgs.ffmpeg];
} ''
  mkdir -p "$out"
  cp ${wayvibesSoundpackSource}/config.json "$out/config.json"
  sed -i 's/\.mp3/.wav/g' "$out/config.json"

  for src in ${wayvibesSoundpackSource}/*.mp3; do
    ffmpeg -hide_banner -loglevel error -y -i "$src" "$out/$(basename "$src" .mp3).wav"
  done
''
