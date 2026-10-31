{ config, lib, pkgs, inputs, ... }:

{

  config = {
    systemSettings = {
      # users
      users = [ "claude" ];
      adminUsers = [ "claude" ];

      # hardware
      cachy.enable = true;
      bluetooth.enable = false;
      powerprofiles.enable = true;
      tlp.enable = false;
      printing.enable = false;

      # software
      flatpak.enable = true;
      gaming.enable = false;
      virtualization = {
        docker.enable = false;
        virtualMachines.enable = false;
      };
      brave.enable = false;

      # wm
      hyprland.enable = true;

      # dotfiles
      dotfilesDir = "/etc/nixos";

      # security
      security = {
        automount.enable = true;
        blocklist.enable = true;
        doas.enable = false;
        firejail.enable = false; # TODO setup firejail profiles
        firewall.enable = true;
        gpg.enable = true;
        openvpn.enable = true;
        sshd.enable = false;
      };

      # style
      stylix = {
        enable = true;
        theme = "solarized-light";
      };
    };

    users.users.claude.description = "claude";
    home-manager.users.claude.userSettings = {
      name = "claude";
      email = "rlazarenko843@gmail.com";
    };

    hardware.xpad-noone.enable = lib.mkForce false;
    hardware.graphics = {
      enable = true;
      enable32Bit = true;
    };
    hardware.nvidia = {
      modesetting.enable = true;
      powerManagement.enable = true;
      powerManagement.finegrained = true;
      open = true;
      package = config.boot.kernelPackages.nvidiaPackages.beta;
      prime = {
        offload.enable = true;
        offload.enableOffloadCmd = true;
        amdgpuBusId = "PCI:5:0:0";
        nvidiaBusId = "PCI:1:0:0";
      };
    };
    services.xserver.videoDrivers = [ "nvidia" ];
    services.fprintd.enable = true;
    services.udev.extraRules = ''
    ACTION=="add", SUBSYSTEM=="usb", ATTR{idVendor}=="04f3", ATTR{idProduct}=="0c4f", ATTR{power/control}="on"
    '';

    zramSwap = {
      enable = true;
      priority = 100;
      memoryPercent = lib.mkForce 150;
      swapDevices = 1;
      algorithm = "zstd";
    };


  programs.nix-ld = {
    enable = true;
    libraries = with pkgs; [ 
    libGL
    xorg.libX11
    xorg.libXext
    xorg.libXfixes
    ];
  };

    nixpkgs.config.allowUnfree = true;

    hardware.firmware = [
      (pkgs.runCommand "100hz-edid" {} ''
        mkdir -p $out/lib/firmware/edid
        cp ${./100hz.bin} $out/lib/firmware/edid/100hz.bin
      '')
    ];

    boot.kernelParams = [
      "drm.edid_firmware=eDP-1:edid/100hz.bin"
      "usbhid.mousepoll=1"
    ];
  };
}
