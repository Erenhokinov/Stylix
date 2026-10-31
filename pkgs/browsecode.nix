{ lib, python3Packages, fetchurl }:

python3Packages.buildPythonApplication rec {
  pname = "browse-code";
  version = "0.2.83";
  format = "wheel";

  src = fetchurl {
    url = "https://files.pythonhosted.org/packages/py3/b/browse-code/browse_code-0.2.83-py3-none-any.whl";
    sha256 = "377fc73416ab76f1d7ea5cbce7f992e03de68c93adb9465e42f01ddbc51a4944";
  };

  propagatedBuildInputs = with python3Packages; [
    fastapi
    uvicorn
    rich
    pydantic
  ];

  doCheck = false;

  postInstall = ''
    mv $out/bin/bc $out/bin/browsecode
  '';

  meta = with lib; {
    description = "CLI tool that turns AI chatbots into autonomous coding agents";
    homepage = "https://github.com/Dedeep007/browse_code";
    license = licenses.mit;
  };
}
