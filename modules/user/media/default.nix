{
  config,
  lib,
  pkgs,
  ...
}: let
  cfg = config.userSettings.media;

  # nixpkgs' yt-dlp is too old for YouTube's PO-token requirements and breaks
  # mpv's ytdl_hook with HTTP 403. Pin the latest upstream release binary.
  yt-dlp-fresh = pkgs.stdenvNoCC.mkDerivation {
    pname = "yt-dlp";
    version = "2026.10.26";
    src = pkgs.fetchurl {
      url = "https://github.com/yt-dlp/yt-dlp/releases/download/2026.10.26/yt-dlp_linux";
      hash = "sha256-dnup3OcFKqGW+LEmUvQz123hKLoWiWb6hLY5TV5sZ5U=";
    };
    installPhase = ''
      mkdir -p $out/bin
      cp $src $out/bin/yt-dlp
      chmod +x $out/bin/yt-dlp
    '';
  };

  # mpv with a current yt-dlp baked into its wrapper PATH fallback, launched on
  # the NVIDIA dGPU (GTX 1650) instead of the AMD iGPU.
  mpv-dgpu = pkgs.writeShellApplication {
    name = "mpv";
    runtimeInputs = [(pkgs.mpv.override {yt-dlp = yt-dlp-fresh;})];
    text = ''
      export __NV_PRIME_RENDER_OFFLOAD=1
      export __GLX_VENDOR_LIBRARY_NAME=nvidia
      export __EGL_VENDOR_LIBRARY_FILENAMES=/run/opengl-driver/share/glvnd/egl_vendor.d/10_nvidia.json
      exec ${lib.getExe (pkgs.mpv.override {yt-dlp = yt-dlp-fresh;})} "$@"
    '';
  };
in {
  options = {
    userSettings.media = {
      enable = lib.mkEnableOption "Enable media playback apps";
    };
  };

  config = lib.mkIf cfg.enable {
    home.packages = with pkgs; [
      vlc
      mpv-dgpu
      yt-dlp-fresh
      ffmpeg
    ];
  };
}
