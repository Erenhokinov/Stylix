{ pkgs, python3Packages, fetchurl, lib }:

let
  pythonEnv = python3Packages.python.withPackages (ps: with ps; [
    pyqt6
    mido
    numpy
    pynput
    evdev
    python-rtmidi
  ]);

  src = fetchurl {
    url = "https://raw.githubusercontent.com/Erenhokinov/Just-a-minute/main/HuMidi-ydotool-patched-midi.zip";
    hash = "sha256-bcnnLtLfjZRV0jxrV8E4X4t4zTvL1tRMlvgazLhh/IY=";
  };

  unpacked = pkgs.stdenvNoCC.mkDerivation {
    pname = "humidi-src";
    version = "2.0-ydotool-patched";
    inherit src;
    nativeBuildInputs = [ pkgs.unzip ];
    unpackPhase = ''
      unzip -q $src -d .
    '';
    postPatch = ''
      substituteInPlace humidi/managers/ConfigManager.py \
        --replace-fail \
          "self.save_dir = os.path.join(self.root_dir, 'saves')" \
          "self.save_dir = str(Path.home() / '.humidi' / 'saves')"
    '';
    installPhase = ''
      mkdir -p $out
      cp -r humidi/* $out/
    '';
  };

in
pkgs.writeShellScriptBin "humidi" ''
  export PATH="${pkgs.ydotool}/bin:${pkgs.alsa-utils}/bin:$PATH"
  exec ${pythonEnv}/bin/python3 ${unpacked}/main.py "$@"
''
