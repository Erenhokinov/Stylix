{ config, lib, ... }:

let
  cfg = config.userSettings.xdg;
in
{
  options = {
    userSettings.xdg = {
      enable = lib.mkEnableOption "Enable xdg user dirs with my xdg directory structure";
    };
  };

  config = lib.mkIf cfg.enable {
    # TODO fix mime associations, most of them are totally broken :(
    xdg.enable = true;
    xdg.userDirs = {
      enable = true;
      createDirectories = true;
      setSessionVariables = true;
      music = "${config.home.homeDirectory}/Media/Music";
      videos = "${config.home.homeDirectory}/Media/Videos";
      pictures = "${config.home.homeDirectory}/Media/Pictures";
      templates = "${config.home.homeDirectory}/Templates";
      download = "${config.home.homeDirectory}/Downloads";
      documents = "${config.home.homeDirectory}/Documents";
      desktop = null;
      publicShare = null;
      extraConfig = {
        DOTFILES = "${config.home.homeDirectory}/.dotfiles";
        ARCHIVE = "${config.home.homeDirectory}/Archive";
        PROJECTS = "${config.home.homeDirectory}/Projects";
        CLOUD = "${config.home.homeDirectory}/Drive";
        BOOK = "${config.home.homeDirectory}/Media/Books";
        VM = "${config.home.homeDirectory}/Machines";
        NOTES = "${config.home.homeDirectory}/Notes";
        KP = "${config.home.homeDirectory}/KP";
        SCREENSHOT = "${config.home.homeDirectory}/Screenshots";
      };
    };
    xdg.mime.enable = true;
    xdg.mimeApps.enable = true;
  };
}
