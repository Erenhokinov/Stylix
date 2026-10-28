{ pkgs, lib, fetchurl, ... }:

pkgs.stdenv.mkDerivation {
  pname = "RomanNow";
  version = "1.0.4";

  src = fetchurl {
  url = "https://github.com/OpenCloudGaming/OpenNOW/releases/download/v1.0.4-nightly.1346.1/OpenNOW-Qt-1.0.4-nightly.1346.1-Linux-x64.deb";
  hash = "sha256-yp5EANnRs8ljOr+4aLH0y2a/UntxkASXXYHTjFlkujQ=";
  };
nativeBuildInputs = with pkgs; [
  dpkg
  autoPatchelfHook
  autoAddDriverRunpath
];
buildInputs = with pkgs; [
  wayland
  xorg.libX11
  libglvnd
  libdrm
  makeWrapper
  fontconfig
  zlib
  freetype
  libgpg-error
  alsa-lib
  vulkan-loader
  e2fsprogs
  stdenv.cc.cc.lib
];
unpackPhase = ''
  runHook preUnpack
dpkg-deb -x $src .
runHook postUnpack
'';
installPhase = ''
  runHook preInstall
  mkdir -p $out/share $out/opt $out/bin
  cp -r -p opt/opennow $out/opt/opennow
  cp -r -p usr/share/* $out/share/
  cat > $out/bin/opennow << EOF
  #!/bin/sh
  export LD_LIBRARY_PATH="${pkgs.pipewire}/lib:\$LD_LIBRARY_PATH"
  export LD_LIBRARY_PATH="${pkgs.alsa-lib}/lib:\$LD_LIBRARY_PATH"
  export XKB_CONFIG_ROOT="${pkgs.xkeyboard_config}/share/X11/xkb"
  export LD_LIBRARY_PATH="${pkgs.vulkan-loader}/lib:\$LD_LIBRARY_PATH"
  exec $out/opt/opennow/AppRun "\$@"
  EOF
  chmod +x $out/opt/opennow/AppRun
  chmod +x $out/bin/opennow
  runHook postInstall
'';
}
