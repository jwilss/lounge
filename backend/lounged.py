#!/usr/bin/env python3
"""
lounged: the Lounge box service.

Serves the launcher and the phone remote, stores your apps and settings,
opens apps in Sway, handles the Home button, and controls the VPN, volume
and power. Standard library only, so there is nothing extra to install.

    python3 lounged.py            # on the box (inside Sway)
    python3 lounged.py --dev      # anywhere else: apps open in your browser instead

The API only answers devices on your home network.
"""

import argparse
import ipaddress
import json
import mimetypes
import os
import queue
import re
import shutil
import signal
import socket
import struct
import subprocess
import sys
import threading
import time
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

VERSION = "0.6.1"
PORT = int(os.environ.get("LOUNGE_PORT", "8737"))
ROOT = Path(os.environ.get("LOUNGE_ROOT", Path(__file__).resolve().parent.parent))
DATA = Path(os.environ.get("LOUNGE_DATA", Path.home() / ".local/share/lounge"))
EXTENSION_DIR = Path(os.environ.get("LOUNGE_EXTENSION", ROOT / "extension"))
VPN_IMPORT_QUIET = 20  # seconds after the last added server before the keeper connects
VPN_HELPER = os.environ.get("LOUNGE_VPN_HELPER", "/usr/local/libexec/lounge/lounge-vpn")
UPDATE_HELPER = os.environ.get("LOUNGE_UPDATE_HELPER", "/usr/local/libexec/lounge/lounge-update")
DESKTOP_UA = ("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) "
              "Chrome/131.0.0.0 Safari/537.36")

STATIC = {
    "/": ROOT / "launcher/index.html",
    "/remote": ROOT / "remote/index.html",
    "/admin": ROOT / "remote/index.html",  # the same page; "admin" is how it's used from a computer
}
STATIC_DIRS = {
    "/css/": ROOT / "launcher/css",
    "/js/": ROOT / "launcher/js",
    "/fonts/": ROOT / "launcher/fonts",
    "/vendor/": ROOT / "launcher/vendor",
    "/shared/": ROOT / "shared",
    "/remote/": ROOT / "remote",
    "/brand/": ROOT / "brand",
}


def log(*a):
    print(time.strftime("%H:%M:%S"), *a, flush=True)


# ------------------------------------------------------------------ storage

# Settings that belong to the box, shared by everyone; everything else is per person.
BOX_KEYS = {"clock24", "screensaverMinutes", "screensaverStyle", "screensaverBounceColours", "screenOffMinutes", "tvUserAgent", "chromeFlags", "screensaverFolder", "lastServer",
            "vpnOn", "vpnKillSwitch", "remoteAddress", "vpnAdded", "vpnValidDays", "seeded"}
USER_KEYS = {"keyboardLayout", "displaySize", "youtubeChannels", "magnifierZoom", "magnifierSize",
             "pointerSize", "appNames", "airPointer"}
PROFILE_COLOURS = ["#ff9f0a", "#30d158", "#0a84ff", "#bf5af2", "#ff375f", "#64d2ff", "#ffd60a", "#ac8e68"]


class Store:
    """Box data in DATA; each person's own settings, Continue watching and app sign-ins
    in DATA/users/<id>/ (apps/<app id> holds that person's browser profile for the app)."""

    def __init__(self):
        DATA.mkdir(parents=True, exist_ok=True)
        (DATA / "icons").mkdir(exist_ok=True)
        (DATA / "snaps").mkdir(exist_ok=True)
        self.lock = threading.RLock()
        self._migrate()

    def _read(self, name, default):
        p = DATA / name
        try:
            return json.loads(p.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return default

    def _write(self, name, value):
        p = DATA / name
        p.parent.mkdir(parents=True, exist_ok=True)
        tmp = p.with_suffix(".tmp")
        tmp.write_text(json.dumps(value, indent=2), encoding="utf-8")
        tmp.replace(p)

    # ---- people
    def _migrate(self):
        """Before 0.4 there was one person: their data becomes the first profile."""
        with self.lock:
            if self._read("profiles.json", None) is not None:
                return
            uid = "main"
            udir = DATA / "users" / uid
            (udir / "apps").mkdir(parents=True, exist_ok=True)
            old = self._read("settings.json", {})
            mine = {k: v for k, v in old.items() if k in USER_KEYS or k == "jellyfin"}
            self._write(f"users/{uid}/settings.json", mine)
            self._write("settings.json", {k: v for k, v in old.items() if k not in mine})
            if (DATA / "recents.json").exists():
                (DATA / "recents.json").replace(udir / "recents.json")
            if (DATA / "profiles").is_dir():  # browser profiles per app
                for d in (DATA / "profiles").iterdir():
                    if d.is_dir() and not d.name.startswith("_") and not (udir / "apps" / d.name).exists():
                        d.replace(udir / "apps" / d.name)
                try:
                    (DATA / "profiles").rmdir()
                except OSError:
                    pass
            self._write("profiles.json", {"current": uid, "users": [
                {"id": uid, "name": "Main", "colour": PROFILE_COLOURS[0]}]})

    def profiles(self):
        with self.lock:
            p = self._read("profiles.json", {})
            users = p.get("users") or [{"id": "main", "name": "Main", "colour": PROFILE_COLOURS[0]}]
            cur = p.get("current") if any(u["id"] == p.get("current") for u in users) else users[0]["id"]
            return {"current": cur, "users": users}

    def current_user(self):
        return self.profiles()["current"]

    def user_dir(self, uid=None):
        d = DATA / "users" / (uid or self.current_user())
        (d / "apps").mkdir(parents=True, exist_ok=True)
        return d

    def add_profile(self, name, colour=None):
        with self.lock:
            p = self.profiles()
            name = str(name or "").strip()[:24]
            if not name:
                raise ValueError("give the profile a name")
            if len(p["users"]) >= 8:
                raise ValueError("8 profiles is the most")
            base = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")[:16] or "user"
            uid, n = base, 2
            while any(u["id"] == uid for u in p["users"]):
                uid, n = f"{base}-{n}", n + 1
            used = {u.get("colour") for u in p["users"]}
            colour = colour if colour in PROFILE_COLOURS else next(
                (c for c in PROFILE_COLOURS if c not in used), PROFILE_COLOURS[len(p["users"]) % len(PROFILE_COLOURS)])
            p["users"].append({"id": uid, "name": name, "colour": colour})
            self._write("profiles.json", p)
            self.user_dir(uid)
            return p

    def update_profile(self, uid, name=None, colour=None):
        with self.lock:
            p = self.profiles()
            for u in p["users"]:
                if u["id"] == uid:
                    if name is not None and str(name).strip():
                        u["name"] = str(name).strip()[:24]
                    if colour in PROFILE_COLOURS:
                        u["colour"] = colour
                    self._write("profiles.json", p)
                    return p
            raise ValueError("no such profile")

    def remove_profile(self, uid):
        with self.lock:
            p = self.profiles()
            if uid == p["current"]:
                raise ValueError("switch to someone else first")
            if not any(u["id"] == uid for u in p["users"]):
                raise ValueError("no such profile")
            p["users"] = [u for u in p["users"] if u["id"] != uid]
            self._write("profiles.json", p)
            d = DATA / "users" / uid
            if re.fullmatch(r"[a-z0-9-]+", uid) and d.is_dir():
                shutil.rmtree(d, ignore_errors=True)
            return p

    def set_current(self, uid):
        with self.lock:
            p = self.profiles()
            if not any(u["id"] == uid for u in p["users"]):
                raise ValueError("no such profile")
            p["current"] = uid
            self._write("profiles.json", p)
            return p

    # ---- apps (shared by everyone)
    def apps(self):
        with self.lock:
            data = self._read("apps.json", None)
            if data is None:
                data = json.loads(default_apps_file().read_text(encoding="utf-8"))
            return data.get("apps", [])

    def save_apps(self, apps):
        with self.lock:
            clean = [sanitise_app(a) for a in apps if isinstance(a, dict) and a.get("id")]
            self._write("apps.json", {"apps": clean})
            return clean

    # ---- settings: defaults <- box <- this person's
    def settings(self):
        with self.lock:
            base = json.loads((ROOT / "config/settings.default.json").read_text(encoding="utf-8"))
            base.update({k: v for k, v in self._read("settings.json", {}).items() if k not in USER_KEYS})
            mine = self._read(f"users/{self.current_user()}/settings.json", {})
            base.update({k: v for k, v in mine.items() if k in USER_KEYS or k == "jellyfin"})
            return base

    def save_settings(self, s, internal=False):
        with self.lock:
            user_ok = set(USER_KEYS) | ({"jellyfin"} if internal else set())
            # jellyfin is only set by the sign-in endpoint, never by the launcher directly
            box = self._read("settings.json", {})
            box.update({k: v for k, v in s.items() if k in BOX_KEYS})
            self._write("settings.json", box)
            path = f"users/{self.current_user()}/settings.json"
            mine = self._read(path, {})
            mine.update({k: v for k, v in s.items() if k in user_ok})
            self._write(path, mine)
            return self.settings()

    def recents(self):
        with self.lock:
            return self._read(f"users/{self.current_user()}/recents.json", {})

    def save_recents(self, r):
        with self.lock:
            self._write(f"users/{self.current_user()}/recents.json", r)


SIZES = {"standard": 1.0, "large": 1.25, "xlarge": 1.5}
POINTER_SIZES = {"standard": 48, "large": 64, "xlarge": 88}
MAGNIFIER = os.environ.get("LOUNGE_MAGNIFIER", "/usr/local/bin/lounge-magnifier")
SIZE_ORDER = ["standard", "large", "xlarge"]

APP_FIELDS = {"id", "name", "type", "url", "tvLayout", "vpn", "color", "shelf", "browser",
              "command", "match", "iconVersion", "autoColor", "arrowKeys"}


def public_settings(s):
    """Settings as the launcher sees them: the Jellyfin sign-in token never leaves the box."""
    out = dict(s)
    jf = s.get("jellyfin") or {}
    out["jellyfin"] = {"server": jf.get("server", ""), "user": jf.get("user", ""), "connected": bool(jf.get("token"))}
    return out


def name_from_url(url):
    host = (urllib.parse.urlparse(url).hostname or "").removeprefix("www.").split(".")
    if len(host) > 2 and host[-2] in ("co", "com", "org", "gov", "ac"):
        core = host[-3]
    else:
        core = host[-2] if len(host) >= 2 else (host[0] if host else "")
    core = core.upper() if 0 < len(core) <= 3 else core.capitalize()
    first = next((seg for seg in urllib.parse.urlparse(url).path.split("/") if seg), "")
    if first and re.fullmatch(r"[A-Za-z][A-Za-z-]{2,20}", first):
        return f"{core} {first.replace('-', ' ').capitalize()}"  # example.co.uk/radio -> Example Radio
    return core or "App"


def sanitise_app(a):
    out = {k: v for k, v in a.items() if k in APP_FIELDS}
    out["id"] = re.sub(r"[^a-z0-9-]", "", str(out["id"]).lower())[:40] or "app"
    out["name"] = str(out.get("name") or "App")[:40]
    if out.get("type") not in ("web", "native"):
        out["type"] = "web"
    if out["type"] == "web":
        url = str(out.get("url") or "")
        if not re.match(r"^https?://", url):
            raise ValueError("web apps need an http(s) address")
        out["url"] = url
    return out


# ------------------------------------------------------------------ events (Server-Sent Events)

class Events:
    def __init__(self):
        self.clients = []
        self.lock = threading.Lock()

    def subscribe(self):
        q = queue.Queue(maxsize=100)
        with self.lock:
            self.clients.append(q)
        return q

    def unsubscribe(self, q):
        with self.lock:
            if q in self.clients:
                self.clients.remove(q)

    def send(self, evt):
        with self.lock:
            for q in list(self.clients):
                try:
                    q.put_nowait(evt)
                except queue.Full:
                    pass


# ------------------------------------------------------------------ helpers

def run(cmd, timeout=8, check=False):
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        if check and r.returncode != 0:
            raise RuntimeError((r.stderr or r.stdout or "failed").strip())
        return r
    except FileNotFoundError:
        raise RuntimeError(f"{cmd[0]} is not installed")


class VirtualKeyboard:
    """A keyboard made through /dev/uinput (standard library only). Sway sees an ordinary
    keyboard and gives windows the box's own layout. wtype makes a one-off keymap instead, and
    new Chromium windows crashed on start with it. Real key presses also count as someone using
    the box (lounge-idle). Needs write access to /dev/uinput (udev uaccess rule)."""

    # linux/input-event-codes.h
    CODES = {"up": 103, "down": 108, "left": 105, "right": 106, "ok": 28, "back": 1,
             "playpause": 164, "menu": 127, "volup": 115, "voldown": 114, "backspace": 14}
    SHIFT = 42
    EV_SYN, EV_KEY, SYN_REPORT = 0, 1, 0
    UI_SET_EVBIT, UI_SET_KEYBIT = 0x40045564, 0x40045565
    UI_DEV_SETUP, UI_DEV_CREATE = 0x405C5503, 0x5501      # struct uinput_setup is 92 bytes
    BUS_VIRTUAL = 0x06

    def __init__(self):
        self.fd = None
        self.lock = threading.Lock()

    def open(self):
        """Creates the device the first time; False if /dev/uinput can't be used."""
        if self.fd is not None:
            return self.fd is not False
        try:
            import fcntl  # Linux only (not needed by the tests or on other systems)
            fd = os.open("/dev/uinput", os.O_WRONLY | os.O_NONBLOCK)
        except (OSError, ImportError) as e:
            log("no virtual keyboard (", e, "), using wtype")
            self.fd = False
            return False
        try:
            fcntl.ioctl(fd, self.UI_SET_EVBIT, self.EV_KEY)
            for code in [*self.CODES.values(), self.SHIFT]:
                fcntl.ioctl(fd, self.UI_SET_KEYBIT, code)
            setup = struct.pack("HHHH80sI", self.BUS_VIRTUAL, 0x4C4E, 0x0001, 1, b"Lounge admin keyboard", 0)
            fcntl.ioctl(fd, self.UI_DEV_SETUP, setup)
            fcntl.ioctl(fd, self.UI_DEV_CREATE)
        except OSError as e:
            log("virtual keyboard failed (", e, "), using wtype")
            os.close(fd)
            self.fd = False
            return False
        self.fd = fd
        time.sleep(0.5)  # give Sway a moment to pick up the new keyboard
        return True

    def _event(self, etype, code, value):
        os.write(self.fd, struct.pack("qqHHi", 0, 0, etype, code, value))  # struct input_event, 64-bit

    def tap(self, code):
        with self.lock:
            self._event(self.EV_KEY, code, 1)
            self._event(self.EV_SYN, self.SYN_REPORT, 0)
            time.sleep(0.02)
            self._event(self.EV_KEY, code, 0)
            self._event(self.EV_SYN, self.SYN_REPORT, 0)

    def key(self, name):
        """Presses a named key; False if there's no virtual keyboard (use wtype instead)."""
        if name not in self.CODES or not self.open():
            return False
        self.tap(self.CODES[name])
        return True

    def settle(self):
        """After wtype has typed text: a Shift tap from this keyboard makes it the one Sway hands
        to new windows again, instead of wtype's one-off keymap."""
        if self.open():
            self.tap(self.SHIFT)


# (app id, old default colour) -> new brand colour, for built-in apps whose colour changed
BRAND_COLOUR_UPDATES = {}


def default_apps_file():
    """The starting apps: your own list if the installer was given one (--apps), else Lounge's."""
    own = Path("/etc/lounge/apps.default.json")
    return own if own.is_file() else ROOT / "config/apps.default.json"


def app_logo(app_id):
    """The logo file for an app: uploaded to the box (DATA/logos) first, then the one that comes
    with Lounge (brand/apps). None if it has none (the tile shows the app's name instead)."""
    if not re.fullmatch(r"[a-z0-9][a-z0-9_-]{0,60}", app_id or ""):
        return None
    for folder in (DATA / "logos", ROOT / "brand/apps"):
        for ext in (".svg", ".png"):
            p = folder / (app_id + ext)
            if p.is_file():
                return p
    return None


def lan_ip():
    """The box's address on the home network. Asked each time (at start-up the network may not be
    up yet) and with the VPN's own fwmark, so the answer is the real network card, not the tunnel."""
    try:
        r = subprocess.run(["ip", "-4", "-o", "route", "get", "192.0.2.1", "mark", "0xca6c"],
                           capture_output=True, text=True, timeout=3)
        m = re.search(r"\bsrc (\d+\.\d+\.\d+\.\d+)", r.stdout)
        if m:
            return m.group(1)
    except (OSError, subprocess.SubprocessError):
        pass
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("192.0.2.1", 9))  # no packet is sent; just picks the outgoing interface
        return s.getsockname()[0]
    except OSError:
        return "127.0.0.1"
    finally:
        s.close()


def fetch(url, timeout=8, headers=None, limit=3_000_000):
    h = {"User-Agent": DESKTOP_UA, "Accept-Language": "en-GB,en;q=0.9",
         "Cookie": "CONSENT=YES+1; SOCS=CAI"}  # skips Google's cookie wall for feeds
    h.update(headers or {})
    req = urllib.request.Request(url, headers=h)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read(limit), r.headers.get("Content-Type", ""), r.geturl()


def in_vm():
    """True when running in a virtual machine (testing): apps then run with the GPU off."""
    try:
        r = subprocess.run(["systemd-detect-virt", "--vm"], capture_output=True, text=True, timeout=3)
        return r.returncode == 0 and r.stdout.strip() not in ("", "none")
    except (OSError, subprocess.SubprocessError):
        return False


IN_VM = in_vm()


def which(*names):
    for n in names:
        p = shutil.which(n)
        if p:
            return p
    return None


# ------------------------------------------------------------------ icons and tile colours

ICON_LINK = re.compile(r"<link\b[^>]*>", re.I)
ATTR = re.compile(r'([a-zA-Z-]+)\s*=\s*("([^"]*)"|\'([^\']*)\'|([^\s>]+))')
THEME = re.compile(r'<meta[^>]+name=["\']theme-color["\'][^>]*content=["\'](#[0-9a-fA-F]{3,8})["\']', re.I)


def parse_attrs(tag):
    return {m.group(1).lower(): (m.group(3) or m.group(4) or m.group(5) or "") for m in ATTR.finditer(tag)}


def find_icon(page_url):
    """Returns (bytes, content_type, theme_colour) for the best icon a site offers."""
    html, _, final = fetch(page_url, limit=800_000)
    text = html.decode("utf-8", "ignore")
    head = text[: text.lower().find("</head>") if "</head>" in text.lower() else 200_000]
    candidates = []
    manifest = None
    for tag in ICON_LINK.findall(head):
        a = parse_attrs(tag)
        rel = a.get("rel", "").lower()
        href = a.get("href")
        if not href:
            continue
        if "manifest" in rel:
            manifest = urllib.parse.urljoin(final, href)
        if "icon" in rel:
            size = 0
            m = re.search(r"(\d+)x\d+", a.get("sizes", ""))
            if m:
                size = int(m.group(1))
            elif "apple-touch-icon" in rel:
                size = 180
            elif href.endswith(".svg"):
                size = 256
            candidates.append((size, urllib.parse.urljoin(final, href)))
    if manifest:
        try:
            mdata = json.loads(fetch(manifest, limit=300_000)[0].decode("utf-8", "ignore"))
            for ic in mdata.get("icons", []):
                m = re.search(r"(\d+)x\d+", ic.get("sizes", ""))
                candidates.append((int(m.group(1)) if m else 0, urllib.parse.urljoin(manifest, ic.get("src", ""))))
        except Exception:
            pass
    root = "{0.scheme}://{0.netloc}".format(urllib.parse.urlparse(final))
    candidates += [(180, root + "/apple-touch-icon.png"), (16, root + "/favicon.ico")]
    theme = None
    m = THEME.search(head)
    if m:
        theme = m.group(1)
    for _, url in sorted(candidates, key=lambda c: -c[0]):
        try:
            data, ctype, _ = fetch(url, limit=2_000_000)
            if data and (ctype.startswith("image/") or url.endswith((".png", ".ico", ".svg", ".webp"))):
                return data, ctype or mimetypes.guess_type(url)[0] or "image/png", theme
        except Exception:
            continue
    return None, None, theme


def usable_colour(hexcol):
    """Rejects theme colours that are near-white (a white tile looks wrong on the dark home screen)."""
    h = hexcol.lstrip("#")
    if len(h) == 3:
        h = "".join(c * 2 for c in h)
    try:
        r, g, b = int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16)
    except ValueError:
        return False
    return (0.299 * r + 0.587 * g + 0.114 * b) < 200


# ------------------------------------------------------------------ YouTube top shelf

NS = {"a": "http://www.w3.org/2005/Atom", "yt": "http://www.youtube.com/xml/schemas/2015",
      "media": "http://search.yahoo.com/mrss/"}


def youtube_feed(channel_id):
    data, _, _ = fetch(f"https://www.youtube.com/feeds/videos.xml?channel_id={channel_id}")
    return parse_youtube_feed(data, channel_id)


def parse_youtube_feed(data, channel_id=""):
    root = ET.fromstring(data)
    title = root.findtext("a:title", default=channel_id, namespaces=NS)
    items = []
    for e in root.findall("a:entry", NS):
        vid = e.findtext("yt:videoId", namespaces=NS)
        if not vid:
            continue
        items.append({
            "videoId": vid,
            "title": e.findtext("a:title", default="", namespaces=NS),
            "channel": title,
            "published": e.findtext("a:published", default="", namespaces=NS),
            "thumbnail": f"https://i.ytimg.com/vi/{vid}/hqdefault.jpg",
        })
    return title, items


def resolve_channel(query):
    q = query.strip()
    m = re.search(r"(UC[\w-]{22})", q)
    if m:
        cid = m.group(1)
    else:
        if q.startswith("http"):
            url = q
        else:
            url = "https://www.youtube.com/" + (q if q.startswith("@") else "@" + q)
        html = fetch(url, limit=2_000_000)[0].decode("utf-8", "ignore")
        m = (re.search(r'"externalId":"(UC[\w-]{22})"', html)
             or re.search(r'itemprop="identifier" content="(UC[\w-]{22})"', html)
             or re.search(r'channel_id=(UC[\w-]{22})', html))
        if not m:
            raise ValueError("channel not found")
        cid = m.group(1)
    title, _ = youtube_feed(cid)
    return {"id": cid, "title": title}



# ------------------------------------------------------------------ Continue watching (websites)
#
# The Lounge extension runs inside every web app. When something has played
# full screen for a while it reports the page, title, artwork and progress
# here. Selecting the card later reopens that page, and the site resumes.

RECENTS_PER_APP = 15


def host_of(url):
    return (urllib.parse.urlparse(url).hostname or "").lower().removeprefix("www.")


def app_for_url(apps, url):
    h = host_of(url)
    best = None
    for a in apps:
        if a.get("type") != "web":
            continue
        ah = host_of(a.get("url", ""))
        if ah and (h == ah or h.endswith("." + ah) or ah.endswith("." + h)):
            if best is None or len(ah) > len(host_of(best["url"])):
                best = a
    return best


def youtube_id(url):
    p = urllib.parse.urlparse(url)
    for part in (p.query, p.fragment.split("?", 1)[-1]):
        v = urllib.parse.parse_qs(part).get("v")
        if v and re.fullmatch(r"[\w-]{11}", v[0]):
            return v[0]
    m = re.search(r"youtu\.be/([\w-]{11})", url)
    return m.group(1) if m else None


def clean_recent(app, body):
    url = str(body.get("url") or "")
    if not re.match(r"^https?://", url):
        raise ValueError("bad address")
    item = {
        "url": url[:1000],
        "title": str(body.get("title") or "").strip()[:140] or app["name"],
        "subtitle": str(body.get("subtitle") or "").strip()[:140],
        "thumbnail": str(body.get("image") or "")[:1000] if str(body.get("image") or "").startswith("https://") else "",
        "progress": max(0.0, min(1.0, float(body.get("progress") or 0))),
        "updated": time.time(),
    }
    for site in {app["name"], "YouTube"}:
        for sep in (" - ", " | ", " \u2013 "):
            if item["title"].endswith(sep + site):
                item["title"] = item["title"][: -len(sep + site)].strip()
    vid = youtube_id(url)
    if vid:  # one card per video, reopened in whichever YouTube layout the app uses
        item["key"] = "yt:" + vid
        item["url"] = (f"https://www.youtube.com/tv#/watch?v={vid}" if app.get("tvLayout")
                       else f"https://www.youtube.com/watch?v={vid}")
        item["thumbnail"] = item["thumbnail"] or f"https://i.ytimg.com/vi/{vid}/hqdefault.jpg"
    else:
        p = urllib.parse.urlparse(url)
        item["key"] = f"{p.netloc}{p.path}".lower()
    return item


# ------------------------------------------------------------------ VPN configs

WG_ALLOWED = {"interface": {"privatekey", "address", "dns", "mtu", "listenport"},
              "peer": {"publickey", "presharedkey", "allowedips", "endpoint", "persistentkeepalive"}}


def check_wireguard_text(text):
    """Friendly check before handing a config to the root helper (which checks again)."""
    if not text or len(text) > 20000:
        raise ValueError("that file is empty or too big")
    section, seen = None, set()
    for raw in text.splitlines():
        line = raw.split("#", 1)[0].strip()
        if not line:
            continue
        if line.startswith("["):
            section = line.strip("[]").lower()
            if section not in WG_ALLOWED:
                raise ValueError(f"unexpected section [{section}]")
            seen.add(section)
            continue
        key = line.split("=", 1)[0].strip().lower()
        if section is None or key not in WG_ALLOWED[section]:
            raise ValueError(f"setting not allowed: {line.split('=', 1)[0].strip()}")
        seen.add(key)
    if not {"interface", "peer", "privatekey", "endpoint"} <= seen:
        raise ValueError("that doesn't look like a WireGuard config")


def server_name_from_file(filename):
    """'wg-UK-12.conf' or 'myvpn-uk-12 (1).conf' -> 'vpn-uk-12' (the screen shows "UK 12")."""
    base = re.sub(r"\.conf$", "", filename.strip(), flags=re.I)
    base = re.sub(r"\s*\(\d+\)$", "", base)
    base = re.sub(r"[^A-Za-z0-9_.-]+", "-", base).strip("-").lower()
    base = re.sub(r"^(wg|[a-z]*vpn)-?", "", base)
    # some providers add their own server code to the file name ("uk-london-1-UK-100"); the
    # rest of the name already says where it is, so drop it unless that would leave nothing
    short = re.sub(r"-[a-z]{2}(-free)?-\d+$", "", base)
    base = short or base
    return ("vpn-" + base)[:40].rstrip("-") if base else "vpn-server"


# ------------------------------------------------------------------ Jellyfin

class Jellyfin:
    """Talks to your Jellyfin server for Continue watching, Next up and remote play."""

    def __init__(self, server):
        self.server = server

    def conf(self):
        return self.server.store.settings().get("jellyfin") or {}

    def headers(self, token=None):
        auth = (f'MediaBrowser Client="Lounge", Device="{socket.gethostname()}", '
                f'DeviceId="lounge-{socket.gethostname()}", Version="{VERSION}"')
        if token:
            auth += f', Token="{token}"'
        return {"Authorization": auth, "Content-Type": "application/json", "Accept": "application/json"}

    def call(self, method, path, body=None, base=None, token=None, timeout=8):
        c = self.conf()
        base = (base or c.get("server") or "").rstrip("/")
        if not base:
            raise RuntimeError("Jellyfin isn't set up")
        data = json.dumps(body).encode() if body is not None else (b"" if method == "POST" else None)
        req = urllib.request.Request(base + path, data=data, method=method,
                                     headers=self.headers(token or c.get("token")))
        with urllib.request.urlopen(req, timeout=timeout) as r:
            raw = r.read()
            return json.loads(raw) if raw else {}

    def login(self, server, username, password):
        server = server.strip().rstrip("/")
        if not re.match(r"^https?://", server):
            server = "http://" + server
        if not re.search(r":\d+$", urllib.parse.urlparse(server).netloc):
            server += ":8096"
        r = self.call("POST", "/Users/AuthenticateByName", {"Username": username, "Pw": password}, base=server)
        conf = {"server": server, "token": r["AccessToken"], "userId": r["User"]["Id"], "user": r["User"]["Name"]}
        self.server.store.save_settings({"jellyfin": conf}, internal=True)
        return {"server": server, "user": conf["user"], "connected": True}

    def logout(self):
        self.server.store.save_settings({"jellyfin": {}}, internal=True)

    def image(self, it):
        base = self.conf()["server"]
        if it.get("Type") == "Episode" or not it.get("BackdropImageTags"):
            return f"{base}/Items/{it['Id']}/Images/Primary?maxWidth=720&quality=85"
        return f"{base}/Items/{it['Id']}/Images/Backdrop/0?maxWidth=720&quality=85"

    def card(self, it):
        ud = it.get("UserData") or {}
        if it.get("Type") == "Episode":
            title = it.get("SeriesName") or it.get("Name")
            sub = f"S{it.get('ParentIndexNumber', 0)}, E{it.get('IndexNumber', 0)}: {it.get('Name', '')}"
        else:
            title, sub = it.get("Name"), str(it.get("ProductionYear") or "")
        return {"title": title, "subtitle": sub, "thumbnail": self.image(it),
                "progress": round((ud.get("PlayedPercentage") or 0) / 100, 3),
                "jellyfinItem": it["Id"], "position": ud.get("PlaybackPositionTicks") or 0}

    def shelf(self):
        c = self.conf()
        if not c.get("token"):
            return []
        uid = c["userId"]
        q = "limit=12&mediaTypes=Video&enableImageTypes=Primary,Backdrop&fields=PrimaryImageAspectRatio"
        try:
            resume = self.call("GET", f"/UserItems/Resume?userId={uid}&{q}")
        except Exception:
            resume = self.call("GET", f"/Users/{uid}/Items/Resume?{q}")  # servers older than 10.9
        nextup = self.call("GET", f"/Shows/NextUp?userId={uid}&limit=10&enableImageTypes=Primary,Backdrop")
        sections = []
        if resume.get("Items"):
            sections.append({"title": "Continue watching", "items": [self.card(i) for i in resume["Items"]]})
        seen = {i["Id"] for i in resume.get("Items", [])}
        nxt = [self.card(i) for i in nextup.get("Items", []) if i["Id"] not in seen]
        if nxt:
            sections.append({"title": "Next up", "items": nxt})
        return sections

    def play(self, item_id, position=0):
        """Waits for Jellyfin Desktop on this box to connect, then tells it to play the item."""
        c = self.conf()
        host = socket.gethostname().lower()
        for _ in range(40):
            time.sleep(0.75)
            try:
                sessions = self.call("GET", f"/Sessions?controllableByUserId={c['userId']}")
            except Exception:
                continue
            mine = [x for x in sessions if "jellyfin" in (x.get("Client") or "").lower()
                    and (x.get("DeviceName") or "").lower() == host and x.get("SupportsRemoteControl")]
            if not mine:
                mine = [x for x in sessions if (x.get("DeviceName") or "").lower() == host and x.get("SupportsRemoteControl")]
            if mine:
                sid = mine[0]["Id"]
                q = urllib.parse.urlencode({"playCommand": "PlayNow", "itemIds": item_id, "startPositionTicks": int(position)})
                self.call("POST", f"/Sessions/{sid}/Playing?{q}")
                return True
        log("Jellyfin Desktop never showed up as a session; opened it without playing")
        return False

# ------------------------------------------------------------------ system actions

LAUNCHER_MARK = "lounge-home"  # lounge-launcher puts this Sway mark on the home screen's window
GUARD_CHANGES = {"new", "move", "fullscreen_mode", "floating"}


def home_guard_plan(views, pids, apps):
    """What to do so the home screen always looks like the home screen.

    views: windows from Sway (pid, app_id, con_id, ws, marks, fullscreen_mode)
    pids:  pid -> app id for the apps lounged started
    Returns the Sway commands to run (none when everything is as it should be):
     - any other window from the home screen's own browser (a new tab or window would show
       Chromium's tab strip and search bar) is closed
     - an app window that landed on the home workspace is moved to its own workspace
     - the home screen stays on "home" and stays full screen
    """
    home = next((v for v in views if LAUNCHER_MARK in (v.get("marks") or [])), None)
    if not home:
        return []
    by_match = {}
    for a in apps:
        m = (a.get("match") or {}).get("app_id")
        if m:
            by_match[m] = a["id"]
    cmds = []
    for v in views:
        if v["con_id"] == home["con_id"]:
            continue
        if v["pid"] == home["pid"]:
            cmds.append(f"[con_id={v['con_id']}] kill")
        elif v["ws"] == "home":
            aid = pids.get(v["pid"]) or by_match.get(v.get("app_id"))
            cmds.append(f"[con_id={v['con_id']}] move container to workspace {'app-' + aid if aid else 'app-other'}")
    if home["ws"] != "home":
        cmds.append(f"[con_id={home['con_id']}] move container to workspace home")
    if not home.get("fullscreen_mode"):
        cmds.append(f"[con_id={home['con_id']}] fullscreen enable")
    return cmds


class DevActions:
    """Used off the box: nothing is launched, it just logs what would happen."""
    mode = "dev"

    def __init__(self, server):
        self.server = server
        self.vpn = {"connected": False, "server": None}
        self.vol = {"level": 40, "muted": False}

    def launch(self, app, url=None):
        log("[dev] launch", app["id"], url or app.get("url"))
        return {"ok": True, "dev": True}

    def close(self, app_id=None, all=False):
        log("[dev] close", "all" if all else app_id)
        return {"ok": True}

    def running(self):
        return []

    def home(self):
        return {"already": True}

    def start_guard(self):
        pass

    dev_servers = ["vpn-uk-12", "vpn-uk-27", "vpn-ie-4"]

    def vpn_servers(self):
        return list(self.dev_servers)

    def vpn_import(self, name, content):
        check_wireguard_text(content)
        if name not in self.dev_servers:
            self.dev_servers.append(name)
        log("[dev] imported VPN config", name)
        return name

    def vpn_remove(self, name):
        self.dev_servers = [x for x in self.dev_servers if x != name]

    def killswitch(self, on):
        log("[dev] kill switch", "on" if on else "off")

    def vpn_status(self):
        return dict(self.vpn)

    def vpn_connect(self, server):
        self.vpn = {"connected": True, "server": server}
        return self.vpn_status()

    def vpn_disconnect(self):
        self.vpn = {"connected": False, "server": None}
        return self.vpn_status()

    def volume(self):
        return dict(self.vol)

    def set_volume(self, level, muted):
        self.vol = {"level": max(0, min(100, int(level))), "muted": bool(muted)}
        return dict(self.vol)

    def power(self, action):
        log("[dev] power", action)
        return {"ok": True, "dev": True}

    def apply_size(self, size):
        log("[dev] display size", size)

    def apply_pointer(self):
        log("[dev] pointer size", self.server.store.settings().get("pointerSize"))

    def pointer_events(self, on):
        log("[dev] air mouse pointer", "on" if on else "off")

    def magnifier(self):
        log("[dev] magnifier toggle")
        self.server.magnifier_open = not self.server.magnifier_open
        self.server.events.send({"type": "magnifier", "open": self.server.magnifier_open})

    def snapshot(self):
        pass

    def update(self, action):
        """Pretend updater for working off the box."""
        if action == "check":
            return {"version": "9.9.9", "installed": VERSION, "available": True, "notes": "- Pretend update (dev mode)"}
        if action == "status":
            return {"stage": "idle"}
        log("[dev] update", action)
        return {"started": True}

    def key(self, name):
        log("[dev] key", name)

    def text(self, value):
        log("[dev] text", value)


class SwayActions(DevActions):
    """The real thing: every app gets its own Sway workspace and runs full screen."""
    mode = "box"
    KEYS = {
        "up": "Up", "down": "Down", "left": "Left", "right": "Right", "ok": "Return",
        "back": "Escape", "playpause": "XF86AudioPlay", "menu": "Menu",
        "volup": "XF86AudioRaiseVolume", "voldown": "XF86AudioLowerVolume", "backspace": "BackSpace",
    }

    def __init__(self, server):
        super().__init__(server)
        self.procs = {}  # app id -> Popen
        self.lock = threading.Lock()
        self.keyboard = VirtualKeyboard()
        self.guard_lock = threading.Lock()
        self._ensure_novpn_slice()

    # ---- sway
    def sway(self, *cmd):
        return run(["swaymsg", *cmd])

    def tree(self):
        r = run(["swaymsg", "-t", "get_tree", "-r"])
        try:
            return json.loads(r.stdout)
        except ValueError:
            return {}

    def views(self):
        out = []

        def walk(node, ws=None):
            if node.get("type") == "workspace":
                ws = node.get("name")
            if node.get("pid") and node.get("type") in ("con", "floating_con"):
                out.append({"pid": node["pid"], "app_id": node.get("app_id"), "con_id": node["id"], "ws": ws,
                            "marks": node.get("marks") or [], "fullscreen_mode": node.get("fullscreen_mode", 0)})
            for k in ("nodes", "floating_nodes"):
                for n in node.get(k, []):
                    walk(n, ws)

        walk(self.tree())
        return out

    def focused_workspace(self):
        r = run(["swaymsg", "-t", "get_workspaces", "-r"])
        try:
            return next((w["name"] for w in json.loads(r.stdout) if w.get("focused")), None)
        except ValueError:
            return None

    def _view_for(self, app):
        match = app.get("match") or {}
        proc = self.procs.get(app["id"])
        for v in self.views():
            if match.get("app_id") and v["app_id"] == match["app_id"]:
                return v
            if proc and proc.poll() is None and v["pid"] == proc.pid:
                return v
        return None

    # ---- apps
    def _command(self, app, url=None):
        settings = self.server.store.settings()
        if app["type"] == "native":
            return list(app.get("command") or [])
        browser = app.get("browser", "chromium")
        profile = self.server.store.user_dir() / "apps" / app["id"]
        if browser == "firefox":
            return self._firefox(app, profile, url)
        if browser == "opera":
            binary = which("opera", "opera-stable")
        else:
            binary = which("chromium", "chromium-browser", "google-chrome-stable", "google-chrome")
        if not binary:
            raise RuntimeError(f"{browser} is not installed")
        cmd = [binary, f"--user-data-dir={profile}", f"--class=lounge-{app['id']}", "--kiosk",
               *settings.get("chromeFlags", [])]
        if IN_VM:
            cmd.append("--disable-gpu")  # a VM's pretend graphics card draws Chromium badly
        if app.get("tvLayout"):
            cmd.append(f"--user-agent={settings.get('tvUserAgent')}")
        elif app.get("arrowKeys", True):
            cmd.append("--enable-spatial-navigation")  # arrows move between links and buttons
        if EXTENSION_DIR.is_dir():
            # keyboard + Continue watching inside the app (Opera support to be confirmed on the box)
            cmd.append(f"--load-extension={EXTENSION_DIR}")
        cmd.append(url or app["url"])
        return cmd

    def _firefox(self, app, profile, url=None):
        binary = which("firefox-esr", "firefox")
        if not binary:
            raise RuntimeError("Firefox is not installed")
        profile.mkdir(parents=True, exist_ok=True)
        s = self.server.store.settings()
        zoom = {"standard": 1.25, "large": 1.5, "xlarge": 1.75}.get(s.get("displaySize"), 1.25)
        prefs = {
            "layout.css.devPixelsPerPx": f"{zoom * self.output_scale():.2f}",
            "browser.uidensity": 2,  # touch-size toolbar and tabs: easier with the air mouse
            "browser.startup.homepage": app.get("url") or "https://www.google.co.uk",
            "browser.startup.page": 1,
            "browser.shell.checkDefaultBrowser": False,
            "browser.aboutwelcome.enabled": False,
            "browser.tabs.warnOnClose": False,
            "browser.sessionstore.resume_from_crash": False,
            "datareporting.policy.dataSubmissionPolicyBypassNotification": True,
            "toolkit.telemetry.reportingpolicy.firstRun": False,
            "trailhead.firstrun.didSeeAboutWelcome": True,
            "media.autoplay.default": 0,
            "media.ffmpeg.vaapi.enabled": not IN_VM,
            "gfx.webrender.software": IN_VM,
            # the Lounge keyboard / Continue watching add-on is unsigned and installed by Lounge
            "xpinstall.signatures.required": False,
            "extensions.autoDisableScopes": 0,
            "extensions.enabledScopes": 15,
        }
        lines = [f'user_pref("{k}", {json.dumps(v)});' for k, v in prefs.items()]
        (profile / "user.js").write_text("\n".join(lines) + "\n")
        xpi = Path(os.environ.get("LOUNGE_FIREFOX_XPI", "/usr/share/lounge/lounge-firefox.xpi"))
        if xpi.is_file():
            (profile / "extensions").mkdir(exist_ok=True)
            shutil.copyfile(xpi, profile / "extensions" / "keyboard@lounge.local.xpi")
        return [binary, "--no-remote", "--profile", str(profile), "--name", f"lounge-{app['id']}",
                url or app.get("url") or "https://www.google.co.uk"]

    def output_scale(self):
        try:
            outs = json.loads(run(["swaymsg", "-t", "get_outputs", "-r"]).stdout)
            return float(outs[0].get("scale") or 1) if outs else 1.0
        except (ValueError, IndexError, RuntimeError):
            return 1.0

    def _ensure_slices(self):
        # The VPN split and kill switch match on these slices, which must exist before rules load.
        if not which("systemd-run"):
            return
        for sl in ("lounge-novpn", "lounge-apps"):
            r = run(["systemctl", "--user", "is-active", f"{sl}-anchor.service"])
            if r.stdout.strip() != "active":
                run(["systemd-run", "--user", "--quiet", f"--slice={sl}.slice",
                     f"--unit={sl}-anchor", "sleep", "infinity"])

    _ensure_novpn_slice = _ensure_slices

    def launch(self, app, url=None):
        with self.lock:
            ws = f"app-{app['id']}"
            view = self._view_for(app)
            if view and not url:
                self.sway(f"workspace {ws}")
                if view["ws"] != ws:
                    self.sway(f"[con_id={view['con_id']}] move container to workspace {ws}")
                return {"ok": True, "focused": True}
            if view and url:  # open a specific video: restart the app at that address
                self._kill(app)
                time.sleep(0.6)
            self.sway(f"workspace {ws}")
            cmd = self._command(app, url)
            if which("systemd-run"):
                # Each app gets its own scope so restarting lounged never closes your apps.
                # Apps with the VPN turned off go in lounge-novpn.slice, which the VPN skips.
                slice_ = "lounge-apps.slice" if app.get("vpn", True) else "lounge-novpn.slice"
                cmd = ["systemd-run", "--user", "--scope", "--quiet", f"--slice={slice_}",
                       f"--unit=lounge-app-{app['id']}-{int(time.time())}", "--", *cmd]
            log("launch", app["id"], " ".join(cmd[:3]), "...")
            proc = subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                    start_new_session=True)
            self.procs[app["id"]] = proc
            threading.Thread(target=self._place, args=(app, ws), daemon=True).start()
            return {"ok": True, "started": True}

    def _place(self, app, ws):
        # if you pressed Home while it was loading, the window may land on the wrong workspace
        for _ in range(60):
            time.sleep(0.25)
            v = self._view_for(app)
            if v:
                if v["ws"] != ws:
                    self.sway(f"[con_id={v['con_id']}] move container to workspace {ws}")
                self.server.events.send({"type": "running", "running": self.running()})
                return

    def _kill(self, app):
        match = app.get("match") or {}
        proc = self.procs.pop(app["id"], None)
        if proc and proc.poll() is None:
            try:
                os.killpg(proc.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
        elif match.get("app_id"):
            self.sway(f'[app_id="{match["app_id"]}"] kill')

    def close(self, app_id=None, all=False):
        apps = {a["id"]: a for a in self.server.store.apps()}
        ids = list(apps) if all else [app_id]
        for i in ids:
            if i in apps:
                self._kill(apps[i])
        self.sway("workspace home")
        return {"ok": True}

    def running(self):
        apps = self.server.store.apps()
        views = self.views()
        out = []
        for a in apps:
            proc = self.procs.get(a["id"])
            m = (a.get("match") or {}).get("app_id")
            if (proc and proc.poll() is None) or (m and any(v["app_id"] == m for v in views)):
                out.append(a["id"])
        return out

    def home(self):
        already = self.focused_workspace() == "home"
        if not already:
            try:
                self.snapshot()
            except RuntimeError as e:
                log("snapshot failed:", e)
            self.sway("workspace home")
        return {"already": already}

    # ---- home screen guard
    def start_guard(self):
        threading.Thread(target=self._guard_loop, daemon=True).start()

    def _guard_loop(self):
        """Follows Sway's window events and puts the home screen right straight away if
        anything disturbs it (see home_guard_plan)."""
        while True:
            try:
                p = subprocess.Popen(["swaymsg", "-m", "-r", "-t", "subscribe", '["window"]'],
                                     stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
                self.guard_home()
                dec = json.JSONDecoder()
                buf = ""
                for line in p.stdout:
                    buf += line
                    while True:
                        rest = buf.lstrip()
                        if not rest:
                            buf = ""
                            break
                        try:
                            evt, end = dec.raw_decode(rest)
                        except ValueError:  # not a whole event yet
                            buf = rest
                            break
                        buf = rest[end:]
                        if isinstance(evt, dict) and evt.get("change") in GUARD_CHANGES:
                            self.guard_home()
                p.wait()
            except Exception as e:
                log("home guard:", e)
            time.sleep(2)

    def guard_home(self):
        with self.guard_lock:
            pids = {p.pid: aid for aid, p in list(self.procs.items()) if p.poll() is None}
            for cmd in home_guard_plan(self.views(), pids, self.server.store.apps()):
                log("home guard:", cmd)
                self.sway(cmd)

    # ---- VPN (through a small root helper allowed by sudoers)
    def _vpn(self, *args):
        r = run(["sudo", "-n", VPN_HELPER, *args], timeout=25)
        if r.returncode != 0:
            raise RuntimeError((r.stderr or r.stdout or "VPN helper failed").strip().splitlines()[-1])
        return r.stdout

    def vpn_servers(self):
        try:
            return [s for s in self._vpn("list").split() if s]
        except RuntimeError:
            return []

    def vpn_status(self):
        try:
            return json.loads(self._vpn("status"))
        except (RuntimeError, ValueError):
            return {"connected": False, "server": None}

    def vpn_connect(self, server):
        if not re.fullmatch(r"[A-Za-z0-9_.-]+", server or ""):
            raise ValueError("bad server name")
        self._ensure_novpn_slice()
        self._vpn("up", server, str(os.getuid()))
        return self.vpn_status()

    def vpn_disconnect(self):
        self._vpn("down")
        return self.vpn_status()

    def vpn_import(self, name, content):
        check_wireguard_text(content)
        r = subprocess.run(["sudo", "-n", VPN_HELPER, "import", name], input=content, capture_output=True,
                           text=True, timeout=20)
        if r.returncode != 0:
            raise RuntimeError((r.stderr or "import failed").strip().splitlines()[-1])
        return name

    def vpn_remove(self, name):
        self._vpn("remove", name)

    def killswitch(self, on):
        if on:
            self._ensure_slices()
            self._vpn("killswitch", "on", str(os.getuid()))
        else:
            self._vpn("killswitch", "off")

    # ---- volume (PipeWire)
    def volume(self):
        r = run(["wpctl", "get-volume", "@DEFAULT_AUDIO_SINK@"])
        m = re.search(r"([\d.]+)", r.stdout)
        return {"level": round(float(m.group(1)) * 100) if m else 0, "muted": "MUTED" in r.stdout}

    def set_volume(self, level, muted):
        level = max(0, min(100, int(level)))
        run(["wpctl", "set-volume", "@DEFAULT_AUDIO_SINK@", f"{level / 100:.2f}"])
        run(["wpctl", "set-mute", "@DEFAULT_AUDIO_SINK@", "1" if muted else "0"])
        return self.volume()

    def power(self, action):
        verb = {"sleep": "suspend", "restart": "reboot", "poweroff": "poweroff"}.get(action)
        if not verb:
            raise ValueError("unknown power action")

        def go():
            # through sudo (sudoers allows exactly these): without polkit, systemd only takes them from root
            r = run(["sudo", "-n", "/usr/bin/systemctl", verb], timeout=15)
            if r.returncode != 0:
                log("power", action, "failed:", (r.stderr or r.stdout).strip()[-200:])
        threading.Timer(0.8, go).start()
        return {"ok": True}

    # ---- display size: scales the whole screen, so websites and Jellyfin grow too
    def apply_size(self, size):
        """Display size makes Lounge's own screens bigger (the home screen does that itself) and
        the pointer. It no longer rescales the whole screen: apps don't cope with that while
        open, and the magnifier is there for reading inside apps."""
        try:
            outputs = json.loads(run(["swaymsg", "-t", "get_outputs", "-r"]).stdout)
        except ValueError:
            outputs = []
        for o in outputs:
            mode = o.get("current_mode") or {}
            scale = round(max(1.0, (mode.get("height") or 1080) / 1080), 2)  # 4K: 2
            if abs((o.get("scale") or 1) - scale) > 0.01:
                self.sway(f'output "{o["name"]}" scale {scale}')
        self.apply_pointer()

    def apply_pointer(self):
        s = self.server.store.settings()
        px = POINTER_SIZES.get(s.get("pointerSize") or "large", 64)
        theme = "Lounge" if Path("/usr/share/icons/Lounge/cursors").is_dir() else "default"
        self.sway(f"seat * xcursor_theme {theme} {px}")
        self.pointer_events(s.get("airPointer", True) is not False)

    def pointer_events(self, on):
        """Air mouse pointer on or off: off, only the arrows and buttons work, and the
        pointer can't drift about while you're watching."""
        self.sway(f"input type:pointer events {'enabled' if on else 'disabled'}")

    def magnifier(self):
        subprocess.Popen([MAGNIFIER, "--toggle"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                         start_new_session=True)

    def update(self, action):
        r = run(["sudo", "-n", UPDATE_HELPER, action], timeout=60)
        try:
            return json.loads(r.stdout or "{}")
        except ValueError:
            raise RuntimeError((r.stderr or "update helper failed").strip().splitlines()[-1] if r.stderr else "update helper failed")

    def snapshot(self):
        """A picture of the app on screen, for the app switcher."""
        ws = self.focused_workspace() or ""
        if ws.startswith("app-") and which("grim"):
            out = DATA / "snaps" / (re.sub(r"[^a-z0-9-]", "", ws[4:]) + ".jpg")
            run(["grim", "-t", "jpeg", "-q", "72", "-s", "0.35", str(out)], timeout=4)

    # ---- phone remote input (types into whatever is on screen)
    def key(self, name):
        if name == "home":
            return
        k = self.KEYS.get(name)
        if not k:
            raise ValueError("unknown key")
        if not self.keyboard.key(name):
            run(["wtype", "-k", k])
            self.keyboard.settle()

    def text(self, value):
        if value:
            # wtype can type any character (the virtual keyboard only has the remote's keys);
            # settle() then hands Sway's keymap back to an ordinary keyboard
            run(["wtype", "--", value[:500]])
            self.keyboard.settle()


# ------------------------------------------------------------------ HTTP

class Server:
    def __init__(self, dev):
        self.store = Store()
        self.events = Events()
        self.actions = DevActions(self) if dev else SwayActions(self)
        self.shelf_cache = {}
        self.jellyfin = Jellyfin(self)
        self.icon_lock = threading.Lock()
        self.icon_busy = set()
        self.ip = lan_ip()
        self.launcher_ready = 0.0
        self.magnifier_open = False
        self.last_home = 0.0
        self.last_vpn_import = 0.0  # the keeper waits while servers are being added
        self.sleep_at = None        # sleep timer: when the box goes to sleep (lounge-idle warns first)
        self.sleep_minutes = 0
        self.seed_apps()
        try:
            self.actions.apply_size(self.store.settings().get("displaySize", "standard"))
        except Exception as e:
            log("could not apply display size:", e)
        self.apply_killswitch()
        threading.Thread(target=self.vpn_keeper, daemon=True).start()
        self.update_info = {}
        threading.Thread(target=self.update_checker, daemon=True).start()
        self.actions.start_guard()

    # ---- VPN: always on unless you turn it off
    def vpn_state(self):
        st = self.actions.vpn_status()
        s = self.store.settings()
        servers = self.actions.vpn_servers()
        valid = int(s.get("vpnValidDays") or 365) * 86400
        added = s.get("vpnAdded") or {}
        expires = {n: added[n] + valid for n in servers if n in added}
        now = time.time()
        st.update({"servers": servers, "lastServer": s.get("lastServer"),
                   "wanted": bool(s.get("vpnOn", True)), "killSwitch": bool(s.get("vpnKillSwitch", True)),
                   "expires": expires,
                   "expiringSoon": sorted(n for n, t in expires.items() if now <= t < now + 14 * 86400),
                   "expired": sorted(n for n, t in expires.items() if t < now)})
        return st

    def apply_killswitch(self):
        s = self.store.settings()
        on = bool(s.get("vpnKillSwitch", True)) and bool(s.get("vpnOn", True)) and bool(self.actions.vpn_servers())
        try:
            self.actions.killswitch(on)
        except Exception as e:
            log("kill switch:", e)

    def vpn_keeper(self):
        """Connects at start-up and reconnects if the VPN drops, while VPN is switched on."""
        delay = 5
        while True:
            try:
                s = self.store.settings()
                servers = self.actions.vpn_servers()
                # adding servers sends one file at a time; connecting in the middle of that
                # changes the box's routes and DNS under the uploads, so wait until they stop
                adding = time.time() - self.last_vpn_import < VPN_IMPORT_QUIET
                if s.get("vpnOn", True) and servers and not adding and not self.actions.vpn_status().get("connected"):
                    first = s.get("lastServer") if s.get("lastServer") in servers else servers[0]
                    order = [first] + [x for x in servers if x != first]
                    last_err = None
                    for server in order:  # if one server is down or its config has expired, try the next
                        try:
                            log("VPN is down, connecting to", server)
                            self.actions.vpn_connect(server)
                            last_err = None
                            break
                        except Exception as e:
                            last_err = e
                            log("could not connect to", server, e)
                    self.events.send({"type": "vpn", "state": self.vpn_state()})
                    if last_err:
                        raise last_err
                    delay = 5
            except Exception as e:
                log("VPN reconnect failed:", e)
                delay = min(delay * 2, 300)
                time.sleep(delay)
                continue
            time.sleep(30)

    # ---- software updates (signed releases from GitHub; your data and VPN servers stay on the box)
    def check_update(self):
        try:
            info = self.actions.update("check")
        except Exception as e:
            log("update check failed:", e)
            return self.update_info
        if info.get("available") and info.get("version") != self.update_info.get("version"):
            self.events.send({"type": "update", "info": info})
        self.update_info = info
        return info

    def update_checker(self):
        time.sleep(120)  # let the box settle after start-up first
        while True:
            self.check_update()
            time.sleep(24 * 3600)

    def apply_update(self):
        r = self.actions.update("apply")
        threading.Thread(target=self.watch_update, daemon=True).start()
        return r

    def watch_update(self):
        last = None
        for _ in range(900):  # up to 30 minutes
            time.sleep(2)
            try:
                st = self.actions.update("status")
            except Exception:
                continue
            if st != last:
                self.events.send({"type": "update-progress", "status": st})
                last = st
            if st.get("stage") in ("done", "failed"):
                return

    def apps_with_logos(self):
        """The apps, each with "logo" (a URL) when it has one: an uploaded logo on the box, or one
        that comes with Lounge in brand/apps/. Tiles show it in white on the app's colour."""
        out = []
        for a in self.store.apps():
            a = dict(a)
            p = app_logo(a.get("id", ""))
            if p:
                a["logo"] = f"/api/logo/{urllib.parse.quote(a['id'])}?v={int(p.stat().st_mtime)}"
            out.append(a)
        return out

    def seed_apps(self):
        """Adds apps that came with a Lounge update, once (removing them afterwards sticks)."""
        s = self.store.settings()
        seeded = set(s.get("seeded") or [])
        apps = self.store.apps()
        changed = False
        for app in json.loads(default_apps_file().read_text(encoding="utf-8")).get("apps", []):
            if app.get("seedIn") and app["id"] not in seeded:
                seeded.add(app["id"])
                if not any(a["id"] == app["id"] for a in apps):
                    apps.append(app)
                    changed = True
        # built-in apps whose colour changed in a Lounge update, if it was never changed by hand
        for a in apps:
            new = BRAND_COLOUR_UPDATES.get((a.get("id"), (a.get("color") or "").lower()))
            if new:
                a["color"] = new
                changed = True
        if changed:
            self.store.save_apps(apps)
        if seeded != set(s.get("seeded") or []):
            self.store.save_settings({"seeded": sorted(seeded)})

    def home_pressed(self):
        """Home: back to the home screen (or Control Centre if already there).
        Pressed twice quickly: the app switcher."""
        now = time.time()
        double = now - self.last_home < 0.6
        self.last_home = 0.0 if double else now
        if double:
            self.actions.home()  # make sure the home screen is showing under the switcher
            self.events.send({"type": "switcher", "running": self.actions.running()})
            return {"switcher": True}
        r = self.actions.home()
        self.events.send({"type": "home", "already": r["already"]})
        return r

    def set_air_pointer(self, on=None):
        if on is None:
            on = self.store.settings().get("airPointer", True) is False
        self.store.save_settings({"airPointer": bool(on)})
        self.actions.pointer_events(bool(on))
        self.events.send({"type": "pointer", "on": bool(on)})
        return {"on": bool(on)}

    def magnifier(self):
        # the magnifier follows the pointer, so switch the pointer on for it
        if not self.magnifier_open and self.store.settings().get("airPointer", True) is False:
            self.set_air_pointer(True)
        self.actions.magnifier()

    def switch_profile(self, uid):
        if uid == self.store.current_user():
            return self.store.profiles()
        self.actions.close(all=True)  # apps are signed in as the last person
        p = self.store.set_current(uid)
        self.shelf_cache.clear()
        try:
            self.actions.apply_size(self.store.settings().get("displaySize", "standard"))
        except Exception as e:
            log("could not apply display size:", e)
        self.events.send({"type": "profile", "profiles": p})
        return p

    def set_size(self, size=None, cycle=False):
        current = self.store.settings().get("displaySize", "standard")
        if cycle:
            i = SIZE_ORDER.index(current) if current in SIZE_ORDER else 0
            size = SIZE_ORDER[(i + 1) % len(SIZE_ORDER)]
        if size not in SIZES:
            raise ValueError("unknown size")
        self.store.save_settings({"displaySize": size})
        self.actions.apply_size(size)
        self.events.send({"type": "size", "size": size})
        return {"size": size}

    def sleep_timer(self):
        rem = None if self.sleep_at is None else max(0, round(self.sleep_at - time.time()))
        return {"at": self.sleep_at, "remaining": rem, "minutes": self.sleep_minutes if self.sleep_at else 0}

    def set_sleep_timer(self, minutes):
        """Control Centre's sleep timer (Off, 30, 60, 90). lounge-idle shows a minute's warning,
        cancels it if a button is pressed, and otherwise puts the box to sleep."""
        minutes = float(minutes or 0)
        if not 0 <= minutes <= 600:
            raise ValueError("sleep timer must be 0 to 600 minutes")
        self.sleep_minutes = minutes
        self.sleep_at = time.time() + minutes * 60 if minutes > 0 else None
        st = self.sleep_timer()
        self.events.send({"type": "sleeptimer", "state": st})
        log("sleep timer:", f"{minutes:g} minutes" if minutes else "off")
        return st

    def wake_screen(self):
        """The admin page's keys and typing come through a virtual keyboard, which doesn't count
        as someone using the box, so tell lounge-idle (turns the picture back on if it was off)."""
        if self.actions.mode != "box":
            return
        threading.Thread(target=run, daemon=True, args=([
            "busctl", "--user", "call", "org.freedesktop.ScreenSaver", "/org/freedesktop/ScreenSaver",
            "org.freedesktop.ScreenSaver", "SimulateUserActivity"],), kwargs={"timeout": 3}).start()

    def change_volume(self, b):
        """Sets the volume ({"level", "muted"}), steps it ({"step": +5/-5}, which unmutes, like a TV)
        or toggles mute ({"toggleMute": true}), then tells the screen so an open Control Centre
        follows the remote's volume buttons."""
        if "step" in b or b.get("toggleMute"):
            cur = self.actions.volume()
            if b.get("toggleMute"):
                v = self.actions.set_volume(cur["level"], not cur["muted"])
            else:
                v = self.actions.set_volume(cur["level"] + int(b.get("step") or 0), False)
        else:
            v = self.actions.set_volume(b.get("level", 40), b.get("muted", False))
        self.events.send({"type": "volume", "volume": v})
        return v

    def admin_url(self):
        """Where to open the admin page from a computer: the box's .local name (avahi), or the
        remoteAddress override, or localhost in a VM (VirtualBox forwards port 8737 to the PC)."""
        if self.store.settings().get("remoteAddress"):
            return f"http://{self.store.settings()['remoteAddress']}/admin"
        if IN_VM:
            return f"http://localhost:{PORT}/admin"
        return f"http://{socket.gethostname()}.local:{PORT}/admin"

    def info(self):
        # remoteAddress (settings.json) overrides the address in QR codes, e.g. "192.168.1.50:8737"
        # when testing in a VM whose own address your phone can't reach
        addr = self.store.settings().get("remoteAddress") or f"{lan_ip()}:{PORT}"
        return {
            "mode": self.actions.mode,
            "vm": IN_VM,
            "version": VERSION,
            "hostname": socket.gethostname(),
            "address": addr,
            "remoteUrl": f"http://{addr}/remote",
            "adminUrl": self.admin_url(),
            "adminIpUrl": f"http://{addr}/admin",
        }

    def add_app(self, body):
        url = str(body.get("url") or "").strip()
        if not re.match(r"^https?://", url):
            url = "https://" + url
        name = str(body.get("name") or "").strip() or name_from_url(url)
        apps = self.store.apps()
        base = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")[:24] or "app"
        aid, n = base, 2
        while any(a["id"] == aid for a in apps):
            aid, n = f"{base}-{n}", n + 1
        hue = sum(ord(c) * 31 for c in url) % 360
        app = sanitise_app({"id": aid, "name": name, "type": "web", "url": url,
                            "vpn": bool(body.get("vpn", True)), "tvLayout": bool(body.get("tvLayout", False)),
                            "color": f"hsl({hue} 45% 32%)", "autoColor": True})
        apps.append(app)
        self.store.save_apps(apps)
        threading.Thread(target=self.prepare_icon, args=(app,), daemon=True).start()
        self.events.send({"type": "apps", "added": name})
        return app

    def icon_path(self, app_id):
        return DATA / "icons" / re.sub(r"[^a-z0-9-]", "", app_id)

    def prepare_icon(self, app):
        p = self.icon_path(app["id"])
        if app.get("type") != "web":
            return False
        with self.icon_lock:
            if app["id"] in self.icon_busy:
                return False
            self.icon_busy.add(app["id"])
        try:
            return self._prepare_icon(app, p)
        finally:
            with self.icon_lock:
                self.icon_busy.discard(app["id"])

    def _prepare_icon(self, app, p):
        if app.get("browser") == "firefox":  # the browser's own installed icon, not the start page's
            for f in ("/usr/share/icons/hicolor/256x256/apps/firefox-esr.png",
                      "/usr/lib/firefox-esr/browser/chrome/icons/default/default128.png",
                      "/usr/share/icons/hicolor/128x128/apps/firefox-esr.png",
                      "/usr/share/icons/hicolor/256x256/apps/firefox.png"):
                if Path(f).is_file():
                    p.with_suffix(".img").write_bytes(Path(f).read_bytes())
                    p.with_suffix(".type").write_text("image/png")
                    return True
            p.with_suffix(".none").write_text(str(time.time()))
            return False
        try:
            data, ctype, theme = find_icon(app["url"])
        except Exception as e:
            log("icon lookup failed for", app["id"], e)
            data, ctype, theme = None, None, None
        if data:
            p.with_suffix(".img").write_bytes(data)
            p.with_suffix(".type").write_text(ctype)
        else:
            p.with_suffix(".none").write_text(str(time.time()))
        if theme and usable_colour(theme):
            apps = self.store.apps()
            for a in apps:
                if a["id"] == app["id"] and a.get("autoColor"):
                    a["color"] = theme
                    a["iconVersion"] = int(time.time())
            self.store.save_apps(apps)
            self.events.send({"type": "apps"})
        return bool(data)

    def shelf(self, app):
        """Top shelf for an app: a list of sections, each a titled row of cards."""
        sections = []
        if (app.get("match") or {}).get("app_id", "").lower().startswith("org.jellyfin") or app["id"] == "jellyfin":
            try:
                sections += self.jellyfin.shelf()
            except Exception as e:
                log("jellyfin shelf failed:", e)
        recents = self.store.recents().get(app["id"], [])
        if recents:
            sections.insert(0, {"title": "Continue watching", "kind": "recent", "items": [
                {k: r.get(k) for k in ("title", "subtitle", "thumbnail", "progress", "url", "key")}
                for r in sorted(recents, key=lambda r: -r["updated"])]})
        if app.get("shelf") == "youtube":
            vids = self.youtube_uploads(app)
            if vids:
                sections.append({"title": "New from your channels", "items": vids})
        return {"sections": sections}

    def youtube_uploads(self, app):
        channels = self.store.settings().get("youtubeChannels") or []
        key = ",".join(c["id"] for c in channels) + ("|tv" if app.get("tvLayout") else "")
        cached = self.shelf_cache.get(key)
        if cached and time.time() - cached[0] < 900:
            return cached[1]
        items = []
        for ch in channels[:15]:
            try:
                _, vids = youtube_feed(ch["id"])
                items += vids[:4]
            except Exception as e:
                log("feed failed", ch.get("id"), e)
        items.sort(key=lambda v: v["published"], reverse=True)
        tv = app.get("tvLayout")
        out = [{
            "title": v["title"], "subtitle": v["channel"], "thumbnail": v["thumbnail"],
            "url": (f"https://www.youtube.com/tv#/watch?v={v['videoId']}" if tv
                    else f"https://www.youtube.com/watch?v={v['videoId']}"),
        } for v in items[:12]]
        self.shelf_cache[key] = (time.time(), out)
        return out

    def youtube_page(self):
        """Lounge's own YouTube page: the signed-in person's channels, each with its newest
        videos (up to 8), from the channels' feeds. Each feed is cached for 15 minutes."""
        from concurrent.futures import ThreadPoolExecutor
        app = next((a for a in self.store.apps() if a.get("shelf") == "youtube"), None)
        tv = bool(app and app.get("tvLayout"))
        channels = (self.store.settings().get("youtubeChannels") or [])[:20]

        def one(ch):
            key = "page:" + ch["id"]
            cached = self.shelf_cache.get(key)
            if cached and time.time() - cached[0] < 900:
                return cached[1]
            try:
                title, vids = youtube_feed(ch["id"])
            except Exception as e:
                log("feed failed", ch.get("id"), e)
                return {"id": ch["id"], "title": ch.get("title") or ch["id"], "videos": [], "error": True}
            out = {"id": ch["id"], "title": ch.get("title") or title, "videos": [{
                "title": v["title"], "thumbnail": v["thumbnail"], "published": v["published"],
                "url": (f"https://www.youtube.com/tv#/watch?v={v['videoId']}" if tv
                        else f"https://www.youtube.com/watch?v={v['videoId']}"),
            } for v in vids[:8]]}
            self.shelf_cache[key] = (time.time(), out)
            return out
        with ThreadPoolExecutor(max_workers=6) as pool:
            rows = list(pool.map(one, channels))
        return {"app": app["id"] if app else None, "channels": rows}

    def add_recent(self, body):
        apps = self.store.apps()
        app = app_for_url(apps, str(body.get("url") or ""))
        if not app:
            return {"ok": False, "reason": "no app for that site"}
        item = clean_recent(app, body)
        rec = self.store.recents()
        lst = [r for r in rec.get(app["id"], []) if r.get("key") != item["key"]]
        if item["progress"] >= 0.95:  # finished: drop it from Continue watching
            rec[app["id"]] = lst
        else:
            rec[app["id"]] = ([item] + lst)[:RECENTS_PER_APP]
        self.store.save_recents(rec)
        self.events.send({"type": "shelf", "app": app["id"]})
        return {"ok": True, "app": app["id"]}

    def remove_recent(self, app_id, key):
        rec = self.store.recents()
        rec[app_id] = [r for r in rec.get(app_id, []) if r.get("key") != key]
        self.store.save_recents(rec)
        self.events.send({"type": "shelf", "app": app_id})
        return {"ok": True}

    def screensaver_images(self):
        folder = Path(os.path.expanduser(self.store.settings().get("screensaverFolder") or "~/Pictures/Lounge"))
        if not folder.is_dir():
            return []
        files = sorted(p.name for p in folder.iterdir() if p.suffix.lower() in (".jpg", ".jpeg", ".png", ".webp"))
        return ["/api/screensaver/" + urllib.parse.quote(f) for f in files]


def make_handler(srv):
    class Handler(BaseHTTPRequestHandler):
        server_version = "lounged/" + VERSION

        def log_message(self, fmt, *args):
            pass

        # -- helpers
        def allowed(self):
            try:
                ip = ipaddress.ip_address(self.client_address[0])
                return ip.is_private or ip.is_loopback or ip.is_link_local
            except ValueError:
                return False

        def send_json(self, obj, code=200):
            body = json.dumps(obj).encode()
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)

        def send_file(self, path, ctype=None):
            try:
                data = Path(path).read_bytes()
            except OSError:
                return self.send_json({"error": "not found"}, 404)
            self.send_response(200)
            self.send_header("Content-Type", ctype or mimetypes.guess_type(str(path))[0] or "application/octet-stream")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-cache")
            self.end_headers()
            self.wfile.write(data)

        def body(self):
            n = int(self.headers.get("Content-Length") or 0)
            if n > 1_000_000:
                raise ValueError("request too large")
            raw = self.rfile.read(n) if n else b"{}"
            return json.loads(raw or b"{}")

        def app_by_id(self, aid):
            return next((a for a in srv.store.apps() if a["id"] == aid), None)

        # -- routes
        def do_GET(self):
            if not self.allowed():
                return self.send_json({"error": "forbidden"}, 403)
            path = urllib.parse.urlparse(self.path).path
            try:
                if path in STATIC:
                    return self.send_file(STATIC[path], "text/html; charset=utf-8")
                for prefix, folder in STATIC_DIRS.items():
                    if path.startswith(prefix):
                        rel = urllib.parse.unquote(path[len(prefix):])
                        target = (folder / rel).resolve()
                        if folder.resolve() in target.parents and target.is_file():
                            return self.send_file(target)
                        return self.send_json({"error": "not found"}, 404)
                if path == "/api/info":
                    return self.send_json(srv.info())
                if path == "/api/apps":
                    return self.send_json({"apps": srv.apps_with_logos()})
                if path.startswith("/api/logo/"):
                    p = app_logo(urllib.parse.unquote(path.rsplit("/", 1)[1]))
                    if not p:
                        return self.send_json({"error": "no logo"}, 404)
                    return self.send_file(p, "image/svg+xml" if p.suffix == ".svg" else "image/png")
                if path == "/api/settings":
                    return self.send_json(public_settings(srv.store.settings()))
                if path == "/api/sleeptimer":
                    return self.send_json(srv.sleep_timer())
                if path == "/api/youtube/page":
                    return self.send_json(srv.youtube_page())
                if path == "/api/launcher-ready":
                    return self.send_json({"at": srv.launcher_ready})
                if path == "/api/running":
                    return self.send_json({"running": srv.actions.running()})
                if path == "/api/profiles":
                    return self.send_json(srv.store.profiles())
                if path == "/api/update":
                    info = srv.update_info or srv.check_update()
                    try:
                        status = srv.actions.update("status")
                    except Exception:
                        status = {"stage": "idle"}
                    return self.send_json({**info, "status": status})
                if path == "/api/magnifier":
                    return self.send_json({"open": srv.magnifier_open})
                if path.startswith("/api/snapshot/"):
                    aid = re.sub(r"[^a-z0-9-]", "", path.rsplit("/", 1)[1])
                    snap = DATA / "snaps" / f"{aid}.jpg"
                    if not snap.is_file():
                        return self.send_json({"error": "no snapshot"}, 404)
                    return self.send_file(snap, "image/jpeg")
                if path == "/api/vpn":
                    return self.send_json(srv.vpn_state())
                if path == "/api/volume":
                    return self.send_json(srv.actions.volume())
                if path.startswith("/api/shelf/"):
                    app = self.app_by_id(path.rsplit("/", 1)[1])
                    return self.send_json(srv.shelf(app) if app else {"items": []})
                if path.startswith("/api/icon/"):
                    aid = urllib.parse.unquote(path.rsplit("/", 1)[1])
                    p = srv.icon_path(aid)
                    if not p.with_suffix(".img").exists():
                        none = p.with_suffix(".none")
                        fresh = none.exists() and time.time() - none.stat().st_mtime < 86400
                        app = self.app_by_id(aid)
                        if fresh or not app or not srv.prepare_icon(app):
                            return self.send_json({"error": "no icon"}, 404)
                    ctype = p.with_suffix(".type").read_text().strip() if p.with_suffix(".type").exists() else None
                    return self.send_file(p.with_suffix(".img"), ctype)
                if path == "/api/screensaver":
                    return self.send_json({"images": srv.screensaver_images()})
                if path.startswith("/api/screensaver/"):
                    folder = Path(os.path.expanduser(srv.store.settings().get("screensaverFolder") or "~/Pictures/Lounge"))
                    name = Path(urllib.parse.unquote(path.rsplit("/", 1)[1])).name
                    return self.send_file(folder / name)
                if path == "/api/events":
                    return self.stream()
                return self.send_json({"error": "not found"}, 404)
            except (BrokenPipeError, ConnectionResetError):
                pass
            except Exception as e:
                log("GET", path, "error:", e)
                return self.send_json({"error": str(e)}, 500)

        def do_PUT(self):
            return self.do_POST()

        def do_POST(self):
            if not self.allowed():
                return self.send_json({"error": "forbidden"}, 403)
            path = urllib.parse.urlparse(self.path).path
            try:
                b = self.body()
                if path == "/api/apps" and self.command == "PUT":
                    apps = srv.store.save_apps(b.get("apps", []))
                    srv.events.send({"type": "apps"})
                    return self.send_json({"apps": apps})
                if path == "/api/apps":
                    return self.send_json(srv.add_app(b))
                if path == "/api/settings":
                    before = srv.store.settings().get("displaySize")
                    s = srv.store.save_settings(b)
                    srv.shelf_cache.clear()
                    if s.get("displaySize") != before:
                        srv.set_size(s.get("displaySize"))
                    elif "pointerSize" in b:
                        srv.actions.apply_pointer()
                    return self.send_json(public_settings(s))
                if path == "/api/launcher-ready":
                    srv.launcher_ready = time.time()
                    return self.send_json({"at": srv.launcher_ready})
                if path == "/api/recent":
                    return self.send_json(srv.add_recent(b))
                if path == "/api/recent/remove":
                    return self.send_json(srv.remove_recent(str(b.get("app")), str(b.get("key"))))
                if path == "/api/jellyfin/login":
                    r = srv.jellyfin.login(str(b.get("server", "")), str(b.get("username", "")), str(b.get("password", "")))
                    srv.events.send({"type": "shelf", "app": "jellyfin"})
                    return self.send_json(r)
                if path == "/api/jellyfin/logout":
                    srv.jellyfin.logout()
                    srv.events.send({"type": "shelf", "app": "jellyfin"})
                    return self.send_json({"connected": False})
                if path == "/api/size":
                    return self.send_json(srv.set_size(b.get("size"), cycle=bool(b.get("cycle"))))
                if path == "/api/launch":
                    app = self.app_by_id(b.get("id"))
                    if not app:
                        return self.send_json({"error": "no such app"}, 404)
                    url = b.get("url")
                    if url and not re.match(r"^https?://", url):
                        return self.send_json({"error": "bad address"}, 400)
                    if b.get("jellyfinItem"):
                        r = srv.actions.launch(app)
                        threading.Thread(target=srv.jellyfin.play, args=(str(b["jellyfinItem"]), b.get("position") or 0),
                                         daemon=True).start()
                        return self.send_json(r)
                    return self.send_json(srv.actions.launch(app, url))
                if path == "/api/close":
                    return self.send_json(srv.actions.close(b.get("id"), all=bool(b.get("all"))))
                if path == "/api/home":
                    return self.send_json(srv.home_pressed())
                if path == "/api/switcher":
                    srv.actions.snapshot()
                    srv.actions.home()
                    srv.events.send({"type": "switcher", "running": srv.actions.running()})
                    return self.send_json({"ok": True})
                if path == "/api/magnifier":
                    if b.get("event") in ("open", "closed"):  # from the magnifier itself
                        srv.magnifier_open = b["event"] == "open"
                        srv.events.send({"type": "magnifier", "open": srv.magnifier_open})
                    else:
                        srv.magnifier()
                    return self.send_json({"ok": True})
                if path == "/api/update":
                    if b.get("action") == "apply":
                        return self.send_json(srv.apply_update())
                    return self.send_json(srv.check_update())
                if path == "/api/pointer":
                    return self.send_json(srv.set_air_pointer(b.get("on")))
                if path == "/api/profiles":
                    act = b.get("action")
                    if act == "switch":
                        return self.send_json(srv.switch_profile(str(b.get("id"))))
                    if act == "add":
                        p = srv.store.add_profile(b.get("name"), b.get("colour"))
                    elif act == "update":
                        p = srv.store.update_profile(str(b.get("id")), b.get("name"), b.get("colour"))
                    elif act == "remove":
                        p = srv.store.remove_profile(str(b.get("id")))
                    else:
                        return self.send_json({"error": "unknown action"}, 400)
                    srv.events.send({"type": "profile", "profiles": p})
                    return self.send_json(p)
                if path == "/api/vpn":
                    act = b.get("action")
                    if act == "connect":
                        srv.actions.vpn_connect(b.get("server"))
                        srv.store.save_settings({"lastServer": b.get("server"), "vpnOn": True})
                    elif act == "disconnect":
                        srv.store.save_settings({"vpnOn": False})  # stays off until you turn it back on
                        srv.actions.vpn_disconnect()
                    elif act == "killswitch":
                        srv.store.save_settings({"vpnKillSwitch": bool(b.get("on"))})
                    elif act == "import":
                        name = srv.actions.vpn_import(server_name_from_file(str(b.get("filename") or "")),
                                                      str(b.get("content") or ""))
                        cur = srv.store.settings()
                        added = dict(cur.get("vpnAdded") or {})
                        added[name] = time.time()
                        srv.store.save_settings({"vpnAdded": added})
                        srv.last_vpn_import = time.time()
                        if not cur.get("lastServer"):
                            srv.store.save_settings({"lastServer": name})
                    elif act == "remove":
                        srv.actions.vpn_remove(str(b.get("server") or ""))
                    else:
                        return self.send_json({"error": "unknown action"}, 400)
                    srv.apply_killswitch()
                    st = srv.vpn_state()
                    srv.events.send({"type": "vpn", "state": st})
                    return self.send_json(st)
                if path == "/api/volume":
                    return self.send_json(srv.change_volume(b))
                if path == "/api/power":
                    if b.get("action") in ("sleep", "restart", "poweroff") and srv.sleep_at:
                        srv.set_sleep_timer(0)  # done (or overtaken)
                    return self.send_json(srv.actions.power(b.get("action")))
                if path == "/api/sleeptimer":
                    return self.send_json(srv.set_sleep_timer(b.get("minutes", 0)))
                if path == "/api/input":
                    srv.wake_screen()
                    if b.get("key") == "size":
                        srv.set_size(cycle=True)
                    elif b.get("key") == "magnify":
                        srv.magnifier()
                    elif b.get("key") == "pointer":
                        srv.set_air_pointer()
                    elif b.get("key") == "apps":
                        srv.actions.snapshot()
                        srv.actions.home()
                        srv.events.send({"type": "switcher", "running": srv.actions.running()})
                    elif b.get("key") == "home":
                        srv.home_pressed()
                    elif b.get("key"):
                        srv.actions.key(b["key"])
                    if b.get("text"):
                        srv.actions.text(b["text"])
                    return self.send_json({"ok": True})
                if path == "/api/youtube/resolve":
                    return self.send_json(resolve_channel(str(b.get("query", ""))))
                return self.send_json({"error": "not found"}, 404)
            except (BrokenPipeError, ConnectionResetError):
                pass
            except (ValueError, RuntimeError) as e:
                return self.send_json({"error": str(e)}, 400)
            except Exception as e:
                log("POST", path, "error:", e)
                return self.send_json({"error": str(e)}, 500)

        def stream(self):
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Connection", "keep-alive")
            self.end_headers()
            q = srv.events.subscribe()
            try:
                self.wfile.write(b": hello\n\n")
                self.wfile.flush()
                while True:
                    try:
                        evt = q.get(timeout=15)
                        self.wfile.write(f"data: {json.dumps(evt)}\n\n".encode())
                    except queue.Empty:
                        self.wfile.write(b": ping\n\n")
                    self.wfile.flush()
            except (BrokenPipeError, ConnectionResetError, OSError):
                pass
            finally:
                srv.events.unsubscribe(q)

    return Handler


def main():
    ap = argparse.ArgumentParser(description="Lounge box service")
    ap.add_argument("--dev", action="store_true", help="run off the box: log actions instead of doing them")
    ap.add_argument("--port", type=int, default=PORT)
    args = ap.parse_args()
    dev = args.dev or not (sys.platform.startswith("linux") and os.environ.get("SWAYSOCK"))
    srv = Server(dev)
    httpd = ThreadingHTTPServer(("0.0.0.0", args.port), make_handler(srv))
    httpd.daemon_threads = True
    log(f"lounged {VERSION} ({srv.actions.mode}) on http://{srv.ip}:{args.port}  data: {DATA}")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
