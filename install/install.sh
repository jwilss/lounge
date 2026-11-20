#!/bin/bash
# Lounge installer
#
# Turns a fresh, minimal Debian 13 (trixie) install into a Lounge TV box.
# Run it on the box, from the Lounge folder:
#
#   sudo ./install/install.sh
#
# Options:
#   --no-jellyfin   skip the Jellyfin Desktop app
#   --no-opera      skip Opera (some video sites only allow 1080p in Opera on Linux)
#   --no-widevine   skip copying Widevine (DRM) from Google Chrome into Chromium and Opera
#   --no-splash     leave the boot screens alone (no logo splash, GRUB menu and boot text as they were)
#   --update        used by Settings > Software update: skips downloads that are already done
#   --apps FILE     your own starting apps (same format as config/apps.default.json), kept
#                   on the box in /etc/lounge/apps.default.json and used instead of Lounge's list
#
# Never touched, by installs or updates: everyone's data in ~lounge/.local/share/lounge
# (profiles, sign-ins, Continue watching, settings) and the VPN servers in /etc/lounge/vpn.
#   --user NAME     the account that runs the TV (default: lounge)
#
# Safe to run again: it updates files in place.

set -euo pipefail

LOUNGE_USER=lounge
WANT_JELLYFIN=1
WANT_OPERA=1
WANT_WIDEVINE=1
WANT_SPLASH=1
UPDATING=0
APPS_FILE=
while [ $# -gt 0 ]; do
  case "$1" in
    --no-jellyfin) WANT_JELLYFIN=0 ;;
    --no-opera) WANT_OPERA=0 ;;
    --no-widevine) WANT_WIDEVINE=0 ;;
    --no-splash) WANT_SPLASH=0 ;;
    --update) UPDATING=1 ;;
    --user) LOUNGE_USER="$2"; shift ;;
    --apps) APPS_FILE="$(realpath "$2")"; shift ;;
    *) echo "Unknown option: $1"; exit 2 ;;
  esac
  shift
done

SRC="$(cd "$(dirname "$0")/.." && pwd)"
SHARE=/usr/share/lounge
export DEBIAN_FRONTEND=noninteractive

say() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
die() { printf '\nError: %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "run this with sudo"
. /etc/os-release
[ "${ID:-}" = "debian" ] || die "this installer is written for Debian (found ${ID:-unknown})"
[ "$(dpkg --print-architecture)" = "amd64" ] || die "this installer expects an Intel/AMD (amd64) box"
[ -f "$SRC/backend/lounged.py" ] || die "run this from inside the Lounge folder"

# ------------------------------------------------------------ packages
say "Enabling contrib and non-free (needed for Intel's video driver)"
if [ -f /etc/apt/sources.list.d/debian.sources ]; then
  sed -i -E '/^Components:/ { /contrib/! s/$/ contrib/; /non-free( |$)/! s/$/ non-free/ }' /etc/apt/sources.list.d/debian.sources
elif [ -f /etc/apt/sources.list ]; then
  sed -i -E '/^deb / { / contrib/! s/$/ contrib/; / non-free( |$)/! s/$/ non-free/ }' /etc/apt/sources.list
fi

say "Installing packages"
apt-get update
apt-get install -y --no-install-recommends \
  sway swayidle greetd xwayland \
  chromium chromium-sandbox \
  python3 curl ca-certificates gnupg sudo \
  wtype wev \
  pipewire pipewire-pulse wireplumber \
  intel-media-va-driver-non-free vainfo mesa-va-drivers \
  wireguard-tools nftables openresolv \
  fonts-inter fonts-noto-color-emoji adwaita-icon-theme \
  dbus-user-session xdg-desktop-portal-wlr \
  flatpak firefox-esr \
  grim swaybg python3-gi python3-gi-cairo gir1.2-gtk-3.0 gir1.2-gtklayershell-0.1 \
  librsvg2-bin openssh-client unattended-upgrades \
  avahi-daemon
# avahi announces the box's name on the home network, so the admin page is at
# http://<hostname>.local:8737/admin from a computer (Windows, macOS and phones find .local names)

# ------------------------------------------------------------ user
say "Setting up the '$LOUNGE_USER' account"
if ! id "$LOUNGE_USER" >/dev/null 2>&1; then
  useradd --create-home --shell /bin/bash "$LOUNGE_USER"
  passwd --lock "$LOUNGE_USER" >/dev/null
fi
for g in video render input audio; do
  getent group "$g" >/dev/null && usermod -aG "$g" "$LOUNGE_USER"
done
LOUNGE_HOME="$(getent passwd "$LOUNGE_USER" | cut -d: -f6)"

# ------------------------------------------------------------ Lounge files
say "Copying Lounge to $SHARE"
mkdir -p "$SHARE"
for d in backend launcher shared remote config extension brand; do
  rm -rf "${SHARE:?}/$d"
  cp -r "$SRC/$d" "$SHARE/$d"
done
# the web-app keyboard extension needs the shared keyboard file inside it
rm -rf "$SHARE/extension-built"
cp -r "$SRC/extension" "$SHARE/extension-built"
cp "$SRC/shared/keyboard-core.js" "$SHARE/extension-built/"
# ...and the same add-on packed for Firefox (Manifest V2, which Firefox ESR loads unsigned)
python3 - "$SHARE/extension-built" "$SHARE/lounge-firefox.xpi" <<'PYEOF2'
import json, os, sys, zipfile
src, out = sys.argv[1], sys.argv[2]
m = json.load(open(os.path.join(src, "manifest.json")))
m["manifest_version"] = 2
m["permissions"] = m.pop("host_permissions", [])
m["background"] = {"scripts": ["background.js"]}
m["browser_specific_settings"] = {"gecko": {"id": "keyboard@lounge.local", "strict_min_version": "115.0"}}
with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
    z.writestr("manifest.json", json.dumps(m, indent=2))
    for f in os.listdir(src):
        if f != "manifest.json" and os.path.isfile(os.path.join(src, f)):
            z.write(os.path.join(src, f), f)
PYEOF2

python3 -c 'import re,sys;print(re.search(r"^VERSION = \"([^\"]+)\"", open(sys.argv[1]).read(), re.M).group(1))' \
  "$SHARE/backend/lounged.py" > "$SHARE/VERSION"

# maker's mark: the jw_ tile with the version in front of it, for the bottom right of the boot
# screens (Plymouth, the Sway background and the home screen's start-up all use this picture)
python3 - "$SHARE/brand" "$(cat "$SHARE/VERSION")" <<'PYEOF3'
import html, re, sys
brand, version = sys.argv[1], sys.argv[2]
tile = open(brand + "/jw-mark.svg").read()
inner = re.sub(r"^.*?<svg[^>]*>|</svg>\s*$", "", tile, flags=re.S)
# drop metadata elements from other namespaces (e.g. a c2pa content-credentials manifest):
# their xmlns declaration stays on the outer <svg> above, so rsvg-convert would refuse the file
inner = re.sub(r"<([A-Za-z][\w.-]*):[\w.-]+\b[^>]*?(?:/>|>.*?</\1:[\w.-]+\s*>)", "", inner, flags=re.S)
with open(brand + "/maker.svg", "w") as f:
    f.write(f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 88" width="640" height="88">
  <text x="522" y="61" text-anchor="end" font-family="Inter, 'Inter Variable', InterVariable, sans-serif" font-size="46" font-weight="500" fill="#f5f5f7" fill-opacity=".5">{html.escape(version)}</text>
  <svg x="552" y="0" width="88" height="88" viewBox="0 0 256 256">{inner}</svg>
</svg>
""")
PYEOF3
rsvg-convert "$SHARE/brand/maker.svg" -o "$SHARE/brand/maker.png" || true

# logo: the splash picture (Sway background) and the boot splash image come from brand/logo.svg
if ! rsvg-convert -w 3840 -h 2160 "$SHARE/brand/splash.svg" -o "$SHARE/brand/splash.png"; then
  echo "Couldn't draw the splash picture; the boot background will just be black."
  # Sway needs the file to exist, so leave a plain black picture in its place
  python3 -c "import base64,sys;open(sys.argv[1],'wb').write(base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='))" "$SHARE/brand/splash.png"
fi
rsvg-convert -w 1600 "$SHARE/brand/logo.svg" -o "$SHARE/brand/logo.png" || true
chmod -R a+rX "$SHARE"

# big, high-contrast pointer theme
rm -rf /usr/share/icons/Lounge
cp -a "$SRC/system/cursors/Lounge" /usr/share/icons/Lounge
chmod -R a+rX /usr/share/icons/Lounge

install -m 755 "$SRC/system/scripts/lounge-home" /usr/local/bin/lounge-home
install -m 755 "$SRC/system/scripts/lounge-size" /usr/local/bin/lounge-size
install -m 755 "$SRC/system/scripts/lounge-launcher" /usr/local/bin/lounge-launcher
install -m 755 "$SRC/system/scripts/lounge-session" /usr/local/bin/lounge-session
install -m 755 "$SRC/system/scripts/lounge-magnifier" /usr/local/bin/lounge-magnifier
install -m 755 "$SRC/system/scripts/lounge-pointer" /usr/local/bin/lounge-pointer
install -m 755 "$SRC/system/scripts/lounge-volume" /usr/local/bin/lounge-volume
install -m 755 "$SRC/system/scripts/lounge-idle" /usr/local/bin/lounge-idle
install -d -m 755 /usr/local/libexec/lounge
install -m 755 -o root -g root "$SRC/system/scripts/lounge-vpn" /usr/local/libexec/lounge/lounge-vpn
install -m 755 -o root -g root "$SRC/system/scripts/lounge-update" /usr/local/libexec/lounge/lounge-update

install -d -m 755 /etc/lounge/sway
install -m 644 "$SRC/system/sway/config" /etc/lounge/sway/config
install -d -m 700 /etc/lounge/vpn   # your VPN servers live here; never overwritten
# public half of the release key: updates signed with anything else are refused
if [ -s "$SRC/system/update/allowed_signers" ]; then
  install -m 644 "$SRC/system/update/allowed_signers" /etc/lounge/update-signers
fi

# ------------------------------------------------------------ services
say "Installing services"
install -d /etc/systemd/user
install -m 644 "$SRC/system/systemd/lounged.service" /etc/systemd/user/lounged.service
install -m 644 "$SRC/system/systemd/lounge-apps.slice" /etc/systemd/user/lounge-apps.slice
install -m 644 "$SRC/system/systemd/lounge-novpn.slice" /etc/systemd/user/lounge-novpn.slice
install -d /etc/systemd/logind.conf.d
install -m 644 "$SRC/system/systemd/logind-lounge.conf" /etc/systemd/logind.conf.d/lounge.conf

sed "s/^lounge /$LOUNGE_USER /" "$SRC/system/sudoers/lounge" > /tmp/lounge.sudoers
visudo -cf /tmp/lounge.sudoers >/dev/null || die "sudoers file failed its check"
install -m 440 /tmp/lounge.sudoers /etc/sudoers.d/lounge
rm -f /tmp/lounge.sudoers

# your own starting apps, if given (updates keep the copy already on the box)
if [ -n "$APPS_FILE" ]; then
  python3 -c 'import json,sys; json.load(open(sys.argv[1]))["apps"]' "$APPS_FILE" || die "--apps: $APPS_FILE isn't an apps list"
  install -D -m 644 "$APPS_FILE" /etc/lounge/apps.default.json
fi

# virtual keyboard for the admin page's keys (see system/udev/70-lounge-uinput.rules)
echo uinput > /etc/modules-load.d/lounge-uinput.conf
install -m 644 "$SRC/system/udev/70-lounge-uinput.rules" /etc/udev/rules.d/70-lounge-uinput.rules
modprobe uinput 2>/dev/null || true
udevadm control --reload 2>/dev/null || true
udevadm trigger --sysname-match=uinput 2>/dev/null || true

if [ -f /etc/greetd/config.toml ] && [ ! -f /etc/greetd/config.toml.before-lounge ]; then
  cp /etc/greetd/config.toml /etc/greetd/config.toml.before-lounge
fi
sed "s/^user = \"lounge\"/user = \"$LOUNGE_USER\"/" "$SRC/system/greetd/config.toml" > /etc/greetd/config.toml
systemctl enable greetd
# greetd owns the first screen (tty1). Stop the text login prompt from racing it for that screen,
# which can leave greetd stuck and the TV on a login: prompt. Ctrl+Alt+F2 still gives a text login.
systemctl mask getty@tty1.service autovt@tty1.service
systemctl set-default graphical.target

# ------------------------------------------------------------ apps
# Debian's own security fixes (Chromium, Firefox, the kernel...) install by themselves overnight
cat > /etc/apt/apt.conf.d/52lounge-unattended <<'EOF'
Unattended-Upgrade::Origins-Pattern {
  "origin=Debian,codename=${distro_codename},label=Debian-Security";
  "origin=Debian,codename=${distro_codename}-security,label=Debian-Security";
  "origin=Debian,codename=${distro_codename}-updates";
  "origin=Opera Software ASA";
};
Unattended-Upgrade::Automatic-Reboot "false";
EOF
printf 'APT::Periodic::Update-Package-Lists "1";\nAPT::Periodic::Unattended-Upgrade "1";\n' > /etc/apt/apt.conf.d/20auto-upgrades

if [ "$WANT_JELLYFIN" = 1 ] && { [ "$UPDATING" = 0 ] || ! flatpak info org.jellyfin.JellyfinDesktop >/dev/null 2>&1; }; then
  say "Installing Jellyfin Desktop (Flatpak)"
  flatpak remote-add --if-not-exists flathub https://dl.flathub.org/repo/flathub.flatpakrepo
  flatpak install -y --noninteractive flathub org.jellyfin.JellyfinDesktop
fi

if [ "$WANT_OPERA" = 1 ] && { [ "$UPDATING" = 0 ] || ! command -v opera >/dev/null; }; then
  say "Installing Opera (for video sites that only allow 1080p in Opera on Linux)"
  curl -fsSL https://deb.opera.com/archive.key | gpg --dearmor --yes -o /usr/share/keyrings/opera.gpg
  echo "deb [signed-by=/usr/share/keyrings/opera.gpg] https://deb.opera.com/opera-stable/ stable non-free" \
    > /etc/apt/sources.list.d/opera-stable.list
  echo "opera-stable opera-stable/add-deb-source boolean false" | debconf-set-selections
  apt-get update
  apt-get install -y opera-stable
fi

if [ "$WANT_WIDEVINE" = 1 ] && { [ "$UPDATING" = 0 ] || [ ! -d /usr/lib/chromium/WidevineCdm ]; }; then
  say "Adding Widevine (DRM for paid video services) from Google Chrome"
  tmp="$(mktemp -d)"
  curl -fsSL -o "$tmp/chrome.deb" https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb
  dpkg-deb -x "$tmp/chrome.deb" "$tmp/x"
  if [ -d "$tmp/x/opt/google/chrome/WidevineCdm" ]; then
    rm -rf /usr/lib/chromium/WidevineCdm
    cp -r "$tmp/x/opt/google/chrome/WidevineCdm" /usr/lib/chromium/WidevineCdm
    if [ -d /usr/lib/x86_64-linux-gnu/opera/resources ]; then
      echo '["/usr/lib/chromium/WidevineCdm"]' > /usr/lib/x86_64-linux-gnu/opera/resources/widevine_config.json
    fi
  else
    echo "Couldn't find Widevine in the Chrome package; skipping (YouTube and most free sites don't need it)."
  fi
  rm -rf "$tmp"
fi

# ------------------------------------------------------------ boot: logo from power-on to home screen
if [ "$WANT_SPLASH" = 1 ]; then
  say "Boot screen: Lounge logo from power-on, no menu or scrolling text"
  apt-get install -y --no-install-recommends plymouth
  install -d /usr/share/plymouth/themes/lounge
  install -m 644 "$SRC/system/boot/plymouth/lounge.plymouth" "$SRC/system/boot/plymouth/lounge.script" \
    /usr/share/plymouth/themes/lounge/
  if [ -f "$SHARE/brand/logo.png" ]; then
    install -m 644 "$SHARE/brand/logo.png" /usr/share/plymouth/themes/lounge/logo.png
  fi
  # the maker's mark carries the version, so the boot image is rebuilt once per new version
  if [ -f "$SHARE/brand/maker.png" ]; then
    install -m 644 "$SHARE/brand/maker.png" /usr/share/plymouth/themes/lounge/maker.png
  fi
  install -d /etc/systemd/system/plymouth-quit.service.d
  install -m 644 "$SRC/system/boot/plymouth-quit-lounge.conf" /etc/systemd/system/plymouth-quit.service.d/lounge.conf
  mkdir -p /var/lib/lounge
  plymouth-set-default-theme lounge
  # only rebuild the boot image when the splash actually changed (it takes a while)
  splash_sum="$(cat /usr/share/plymouth/themes/lounge/* 2>/dev/null | sha256sum | cut -d' ' -f1)"
  if [ -f /etc/default/grub ]; then
    [ -f /etc/default/grub.before-lounge ] || cp /etc/default/grub /etc/default/grub.before-lounge
    set_grub() {
      if grep -q "^$1=" /etc/default/grub; then sed -i "s|^$1=.*|$1=$2|" /etc/default/grub
      else echo "$1=$2" >> /etc/default/grub; fi
    }
    set_grub GRUB_TIMEOUT 0
    set_grub GRUB_TIMEOUT_STYLE hidden
    set_grub GRUB_CMDLINE_LINUX_DEFAULT '"quiet splash loglevel=3 rd.udev.log_level=3 systemd.show_status=false vt.global_cursor_default=0"'
    if ! cmp -s /etc/default/grub /var/lib/lounge/grub.applied 2>/dev/null; then
      update-grub && install -D -m 644 /etc/default/grub /var/lib/lounge/grub.applied
    fi
  fi
  if [ "$splash_sum" != "$(cat /var/lib/lounge/splash.applied 2>/dev/null)" ]; then
    update-initramfs -u && echo "$splash_sum" > /var/lib/lounge/splash.applied
  fi
fi

# ------------------------------------------------------------ virtual machine (testing)
case "$(systemd-detect-virt --vm 2>/dev/null || true)" in
  ""|none) ;;
  *)
    say "Virtual machine detected: software graphics, and quiet the driver messages on screen"
    echo "kernel.printk = 3 4 1 3" > /etc/sysctl.d/20-quiet-console.conf
    sysctl -q -p /etc/sysctl.d/20-quiet-console.conf || true
    ;;
esac

# ------------------------------------------------------------ first-run data
install -d -o "$LOUNGE_USER" -g "$LOUNGE_USER" "$LOUNGE_HOME/.local/share/lounge" "$LOUNGE_HOME/Pictures/Lounge"

say "Done"
cat <<EOF

Lounge is installed. Next steps:

  1. Reboot. The box starts straight into the home screen.
  2. VPN: download WireGuard config files from your VPN provider,
     then add them on the admin page
     (VPN tab, address below). It checks each file and starts the one-year
     renewal clock.
  3. Screensaver photos: put them in $LOUNGE_HOME/Pictures/Lounge

Admin page, from a computer on your home network (bookmark it):
  http://$(hostname).local:8737/admin   or   http://$(hostname -I | awk '{print $1}'):8737/admin
(Settings > Admin page on the TV shows it too). In VirtualBox use
http://localhost:8737/admin on the PC instead.

If anything goes wrong at boot, press Ctrl+Alt+F2 on a keyboard for a text login.
To see the boot menu (GRUB), hold Shift or tap Esc while the box starts.
Your logo: replace $SRC/brand/logo.svg and run this installer again.
EOF
