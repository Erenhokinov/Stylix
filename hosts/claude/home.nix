{ config, lib, pkgs, inputs, ... }:

let
  transkun = pkgs.callPackage /home/claude/stylix/pkgs/transkun.nix { };
  humidi = pkgs.callPackage /home/claude/stylix/pkgs/humidi.nix { };
in
{
  imports = [
    inputs.spicetify-nix.homeManagerModules.default
    inputs.wayvibes.nixosModules.default
  ];

  config = {
    userSettings = {
      # setup
      shell = {
        enable = true;
        apps.enable = true;
        extraApps.enable = true;
      };
      xdg.enable = true;

      # programs
      browser = "qutebrowser";
      editor = "vscodium";
      vscodium.enable = true;
      yazi.enable = true;
      git.enable = true;
      engineering.enable = false;
      art.enable = false;
      flatpak.enable = true;
      godot.enable = false;
      keepass.enable = false;
      media.enable = false;
      music.enable = false;
      office.enable = false;
      recording.enable = false;
      virtualization = {
        virtualMachines.enable = false;
      };
      ai.enable = false;

      # wm
      hyprland.enable = true;

      # style
      stylix.enable = true;

      # hardware
      bluetooth.enable = true;
    };

    home.sessionVariables = lib.mkIf config.userSettings.hyprland.enable {
      AQ_DRM_DEVICES = "/dev/dri/card2:/dev/dri/card1";
    };

    home.packages = [
     transkun
      humidi
      pkgs.sox
    ];

    programs.spicetify =
      let
        spicePkgs = inputs.spicetify-nix.legacyPackages.${pkgs.stdenv.system};
      in {
        enable = true;
        enabledExtensions = with spicePkgs.extensions; [
          adblockify
          hidePodcasts
        ];
        theme = spicePkgs.themes.nightlight;
        colorScheme = "Nightlight Colors";
      };

    services.wayvibes = {
      enable = true;
      soundpack = "${inputs.wayvibes}/soundpacks/akko_lavender_purples";
      volume = 1;
    };

    systemd.user.services.wayvibes.Service.ExecStart = lib.mkForce ''
      ${config.services.wayvibes.package}/bin/wayvibes ${config.services.wayvibes.soundpack} -v ${toString config.services.wayvibes.volume} --device-name "SEMICO   USB Gaming Keyboard "
    '';

    wayland.windowManager.hyprland = lib.mkIf config.userSettings.hyprland.enable {
      settings = {
        monitor = [
          "eDP-1,1920x1080@100.05,0x0,1"
        ];
      };
    };
  };
}
