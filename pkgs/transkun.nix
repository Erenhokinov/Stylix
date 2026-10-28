{ pkgs, python3Packages, fetchPypi, lib }:

let
  torch = python3Packages.torch-bin;
  torchaudio = python3Packages.torchaudio-bin;

  moduleconf = python3Packages.buildPythonPackage rec {
    pname = "moduleconf";
    version = "0.1.4";
    format = "wheel";
    src = fetchPypi {
      inherit pname version format;
      hash = "sha256-R/1I9c1WbjqxmBBqZt++Y+S56ukk+NtY1m33q6JeXDk=";
      dist = "py3";
      python = "py3";
    };
    doCheck = false;
  };

  pytorch-ranger = python3Packages.buildPythonPackage rec {
    pname = "pytorch_ranger";
    version = "0.1.1";
    format = "wheel";
    src = fetchPypi {
      inherit pname version format;
      hash = "sha256-HmkVbJzIQ5GFy4ukclsYyRlH++cnQ+JaypN9qK6wyOw=";
      dist = "py3";
      python = "py3";
    };
    propagatedBuildInputs = [ torch ];
    doCheck = false;
  };

  torch-optimizer = python3Packages.buildPythonPackage rec {
    pname = "torch_optimizer";
    version = "0.3.0";
    format = "wheel";
    src = fetchPypi {
      inherit pname version format;
      hash = "sha256-fejlcxXkNWHN0DcKG2cwPMjvGwU/m1Vz3mKaYjkPKvk=";
      dist = "py3";
      python = "py3";
    };
    propagatedBuildInputs = [ torch pytorch-ranger ];
    doCheck = false;
  };

  pretty-midi = python3Packages.buildPythonPackage rec {
    pname = "pretty_midi";
    version = "0.2.11.post0";
    format = "wheel";
    src = fetchPypi {
      inherit pname version format;
      hash = "sha256-o+IyFzYkWpySJZcW2FpHYvFre94vWR+w26lb2255PYo=";
      dist = "py3";
      python = "py3";
    };
    propagatedBuildInputs = with python3Packages; [
      numpy mido six importlib-resources
    ];
    doCheck = false;
  };

  ncls = python3Packages.buildPythonPackage rec {
    pname = "ncls";
    version = "0.0.70";
    format = "pyproject";
    src = fetchPypi {
      inherit pname version;
      hash = "sha256-fRZjSo9X+nllnprn5cxu3R4C1ayw61cSjb7QPp9P3Zw=";
    };
    nativeBuildInputs = with python3Packages; [ cython setuptools-scm setuptools wheel ];
    propagatedBuildInputs = [ python3Packages.numpy ];
    doCheck = false;
  };

  sox-py = python3Packages.buildPythonPackage rec {
    pname = "sox";
    version = "1.5.0";
    format = "setuptools";
    src = fetchPypi {
      inherit pname version;
      hash = "sha256-Ese+W7H1SNiR/hHoLAjPXxoddOIlKY9gCC5a6yRpraA=";
    };
    doCheck = false;
  };

in
python3Packages.buildPythonPackage rec {
  pname = "transkun";
  version = "2.0.1";
  format = "wheel";
  src = fetchPypi {
    inherit pname version format;
    hash = "sha256-fX9b+IsNIffaBBWwic/zvLy92gTho8lxmWSUeULIWf4=";
    dist = "py3";
    python = "py3";
  };

  propagatedBuildInputs = with python3Packages; [
    scipy
    torch
    torchaudio
    pydub
    seaborn
    matplotlib
    tensorboard
    tqdm
    soxr
    mir-eval
    ncls
    pretty-midi
    torch-optimizer
    moduleconf
    sox-py
  ];

  doCheck = false;

  meta = with lib; {
    description = "Neural Semi-CRF event-based piano transcription (audio to MIDI), CUDA-enabled";
    homepage = "https://github.com/Yujia-Yan/Skipping-The-Frame-Level";
    license = licenses.mit;
  };
}
