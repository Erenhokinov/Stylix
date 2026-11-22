{
  config,
  lib,
  pkgs,
  nix-flatpak,
  inputs,
  ...
}: let
  transkun = pkgs.callPackage ../../pkgs/transkun.nix {};
  #  romannow = pkgs.callPackage ../../pkgs/Romanich.nix { };
  humidi = pkgs.callPackage ../../pkgs/humidi.nix {};
  wayvibesAkkoLavenderPurples =
    pkgs.callPackage
    ../../pkgs/wayvibes-akko-lavender-purples.nix
    {
      wayvibesSoundpackSource = "${inputs.wayvibes}/soundpacks/akko_lavender_purples";
    };
in {
  imports = [
    inputs.nix-flatpak.homeManagerModules.nix-flatpak
    inputs.spicetify-nix.homeManagerModules.default
    inputs.nixcord.homeModules.nixcord
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
      flatpak.enable = false;
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
    };

    home.sessionVariables = lib.mkIf config.userSettings.hyprland.enable {
      AQ_DRM_DEVICES = "/dev/dri/card2:/dev/dri/card1";
    };

    home.packages = [
      transkun
      #     romannow
      humidi
      pkgs.sox
    ];

    services.flatpak.update.onActivation = true;
    services.flatpak.packages = [
      {
        appId = "org.vinegarhq.Sober";
        origin = "flathub";
      }

      #tralalelo tralala!
    ];

    programs.spicetify = let
      spicePkgs = inputs.spicetify-nix.legacyPackages.${pkgs.stdenv.system};
    in {
      enable = true;
      enabledExtensions = with spicePkgs.extensions; [
        adblockify
        hidePodcasts
        autoVolume
        copyToClipboard
      ];
      theme = spicePkgs.themes.text;
      colorScheme = "GruvboxHard";
    };

    programs.nixcord = {
      enable = true;
      discord.vencord.enable = true;
      config.plugins = {
        hideMedia.enable = true;
        fakeNitro.enable = true;
        silentTyping.enable = true;
        spotifyControls.enable = true;
        crashHandler.enable = true;
      };
    };

    services.wayvibes = {
      enable = true;
      soundpack = "${wayvibesAkkoLavenderPurples}";
      volume = 2;
    };

    xdg.configFile."wayvibes/input_device".text = "PATH:/dev/input/by-id/usb-SEMICO_USB_Gaming_Keyboard-event-kbd";

    wayland.windowManager.hyprland = lib.mkIf config.userSettings.hyprland.enable {
      settings = {
        monitor = [
          "eDP-1,1920x1080@100.05,0x0,1"
        ];
      };
    };
  };
}
