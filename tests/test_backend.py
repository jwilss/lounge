"""Quick checks for the parts of lounged that don't need the box. Run: python3 tests/test_backend.py"""
import sys, unittest
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "backend"))
import lounged

FEED = b"""<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns:yt="http://www.youtube.com/xml/schemas/2015" xmlns:media="http://search.yahoo.com/mrss/" xmlns="http://www.w3.org/2005/Atom">
 <title>Test Channel</title>
 <entry><yt:videoId>abc123DEF45</yt:videoId><title>First video</title><published>2026-11-18T10:00:00+00:00</published></entry>
 <entry><yt:videoId>zzz999YYY88</yt:videoId><title>Second video</title><published>2026-11-17T10:00:00+00:00</published></entry>
</feed>"""

HTML = """<html><head>
<link rel="icon" href="/favicon-32.png" sizes="32x32">
<link rel="apple-touch-icon" href="/touch.png">
<meta name="theme-color" content="#1d3557">
</head><body></body></html>"""


class Tests(unittest.TestCase):
    def test_feed(self):
        title, items = lounged.parse_youtube_feed(FEED)
        self.assertEqual(title, "Test Channel")
        self.assertEqual([i["videoId"] for i in items], ["abc123DEF45", "zzz999YYY88"])
        self.assertTrue(items[0]["thumbnail"].endswith("/abc123DEF45/hqdefault.jpg"))

    def test_names(self):
        self.assertEqual(lounged.name_from_url("https://www.abc.co.uk/radio"), "ABC Radio")
        self.assertEqual(lounged.name_from_url("https://www.twitch.tv/"), "Twitch")

    def test_sanitise_rejects_non_web(self):
        with self.assertRaises(ValueError):
            lounged.sanitise_app({"id": "x", "type": "web", "url": "javascript:alert(1)"})
        a = lounged.sanitise_app({"id": "Bad ID!", "name": "x", "type": "web", "url": "https://a.com", "evil": 1})
        self.assertEqual(a["id"], "badid")
        self.assertNotIn("evil", a)

    def test_theme_colour(self):
        self.assertTrue(lounged.usable_colour("#1d3557"))
        self.assertFalse(lounged.usable_colour("#ffffff"))
        self.assertEqual(lounged.THEME.search(HTML).group(1), "#1d3557")

    def test_icon_links(self):
        tags = [lounged.parse_attrs(t) for t in lounged.ICON_LINK.findall(HTML)]
        self.assertIn("apple-touch-icon", [t["rel"] for t in tags])


class RecentTests(unittest.TestCase):
    APPS = [{"id": "exampletv", "name": "Example TV", "type": "web", "url": "https://www.example.org/tv"},
            {"id": "youtube", "name": "YouTube", "type": "web", "url": "https://www.youtube.com/tv", "tvLayout": True}]

    def test_app_matching(self):
        self.assertEqual(lounged.app_for_url(self.APPS, "https://www.example.org/tv/episode/x")["id"], "exampletv")
        self.assertEqual(lounged.app_for_url(self.APPS, "https://m.youtube.com/watch?v=abcdefghijk")["id"], "youtube")
        self.assertIsNone(lounged.app_for_url(self.APPS, "https://example.com/"))

    def test_clean_titles_and_youtube(self):
        r = lounged.clean_recent(self.APPS[0], {"url": "https://www.example.org/tv/episode/x", "title": "Coastal Walks - Example TV", "progress": 2})
        self.assertEqual(r["title"], "Coastal Walks")
        self.assertEqual(r["progress"], 1.0)
        y = lounged.clean_recent(self.APPS[1], {"url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=30", "title": "Song - YouTube"})
        self.assertEqual(y["key"], "yt:dQw4w9WgXcQ")
        self.assertEqual(y["url"], "https://www.youtube.com/tv#/watch?v=dQw4w9WgXcQ")
        self.assertEqual(y["title"], "Song")

    def test_rejects_non_web(self):
        with self.assertRaises(ValueError):
            lounged.clean_recent(self.APPS[0], {"url": "file:///etc/passwd"})


class VpnTests(unittest.TestCase):
    GOOD = "[Interface]\nPrivateKey = abc=\nAddress = 10.2.0.2/32\nDNS = 10.2.0.1\n[Peer]\nPublicKey = def=\nAllowedIPs = 0.0.0.0/0\nEndpoint = 1.2.3.4:51820\n"

    def test_good_config(self):
        lounged.check_wireguard_text(self.GOOD)

    def test_rejects_scripts(self):
        for bad in ("PostUp = rm -rf /", "PreUp = x", "Table = off", "SaveConfig = true"):
            with self.assertRaises(ValueError):
                lounged.check_wireguard_text(self.GOOD.replace("[Peer]", bad + "\n[Peer]"))

    def test_rejects_junk(self):
        with self.assertRaises(ValueError):
            lounged.check_wireguard_text("hello")

    def test_server_names(self):
        self.assertEqual(lounged.server_name_from_file("wg-UK-12.conf"), "vpn-uk-12")
        self.assertEqual(lounged.server_name_from_file("myvpn-uk-12 (1).conf"), "vpn-uk-12")
        self.assertEqual(lounged.server_name_from_file("uk-london-1-UK-100.conf"), "vpn-uk-london-1")


class HomeGuardTests(unittest.TestCase):
    """The home screen can't drop out of full screen or have other windows over it."""

    def view(self, con, pid, ws, marks=(), fs=1, app_id=None):
        return {"con_id": con, "pid": pid, "ws": ws, "marks": list(marks), "fullscreen_mode": fs, "app_id": app_id}

    def test_all_well(self):
        views = [self.view(1, 100, "home", ["lounge-home"]), self.view(2, 200, "app-youtube")]
        self.assertEqual(lounged.home_guard_plan(views, {200: "youtube"}, []), [])

    def test_no_mark_yet(self):
        self.assertEqual(lounged.home_guard_plan([self.view(1, 100, "home", fs=0)], {}, []), [])

    def test_stray_browser_window_closed(self):
        # e.g. a new tab or window from the home screen's own Chromium (search bar and all)
        views = [self.view(1, 100, "home", ["lounge-home"]), self.view(5, 100, "home", fs=1)]
        self.assertEqual(lounged.home_guard_plan(views, {}, []), ["[con_id=5] kill"])

    def test_full_screen_put_back(self):
        views = [self.view(1, 100, "home", ["lounge-home"], fs=0)]
        self.assertEqual(lounged.home_guard_plan(views, {}, []), ["[con_id=1] fullscreen enable"])

    def test_app_on_home_moved_to_its_workspace(self):
        apps = [{"id": "jellyfin", "match": {"app_id": "org.jellyfin.JellyfinDesktop"}}]
        views = [self.view(1, 100, "home", ["lounge-home"], fs=0), self.view(2, 200, "home"),
                 self.view(3, 300, "home", app_id="org.jellyfin.JellyfinDesktop"), self.view(4, 400, "home")]
        self.assertEqual(lounged.home_guard_plan(views, {200: "youtube"}, apps), [
            "[con_id=2] move container to workspace app-youtube",
            "[con_id=3] move container to workspace app-jellyfin",
            "[con_id=4] move container to workspace app-other",
            "[con_id=1] fullscreen enable",
        ])

    def test_home_screen_moved_back(self):
        views = [self.view(1, 100, "1", ["lounge-home"])]
        self.assertEqual(lounged.home_guard_plan(views, {}, []), ["[con_id=1] move container to workspace home"])


class VersionTests(unittest.TestCase):
    def test_preview_version_matches(self):
        api = (Path(__file__).resolve().parent.parent / "launcher" / "js" / "api.js").read_text()
        self.assertIn(f"version: '{lounged.VERSION}'", api, "update the preview version in launcher/js/api.js")


class ProfileTests(unittest.TestCase):
    """Profiles: old single-person data becomes the first profile; settings split box/person."""

    def setUp(self):
        import tempfile, json as _json
        self.tmp = Path(tempfile.mkdtemp())
        (self.tmp / "profiles" / "youtube").mkdir(parents=True)
        (self.tmp / "profiles" / "_launcher").mkdir(parents=True)
        (self.tmp / "settings.json").write_text(_json.dumps(
            {"displaySize": "xlarge", "vpnOn": False, "jellyfin": {"token": "t"}, "lastServer": "vpn-uk-1"}))
        (self.tmp / "recents.json").write_text(_json.dumps({"youtube": [{"key": "k"}]}))
        self.old = lounged.DATA
        lounged.DATA = self.tmp
        self.store = lounged.Store()

    def tearDown(self):
        import shutil as _sh
        lounged.DATA = self.old
        _sh.rmtree(self.tmp, ignore_errors=True)

    def test_migration(self):
        self.assertEqual(self.store.current_user(), "main")
        s = self.store.settings()
        self.assertEqual(s["displaySize"], "xlarge")
        self.assertFalse(s["vpnOn"])
        self.assertTrue((self.tmp / "users/main/apps/youtube").is_dir())
        self.assertTrue((self.tmp / "profiles/_launcher").is_dir())  # the home screen's own profile stays put
        self.assertEqual(self.store.recents(), {"youtube": [{"key": "k"}]})

    def test_people_are_separate(self):
        self.store.add_profile("Sam")
        self.store.set_current("sam")
        s = self.store.settings()
        self.assertEqual(s["displaySize"], "standard")      # Sam starts with defaults
        self.assertFalse(s["vpnOn"])                         # box settings are shared
        self.assertEqual(s.get("jellyfin"), {})
        self.assertEqual(self.store.recents(), {})
        self.store.save_settings({"displaySize": "large", "clock24": False, "jellyfin": {"x": 1}})
        self.assertNotIn("x", self.store.settings().get("jellyfin", {}))  # only the sign-in endpoint sets it
        self.store.set_current("main")
        self.assertEqual(self.store.settings()["displaySize"], "xlarge")
        self.assertFalse(self.store.settings()["clock24"])

    def test_remove(self):
        self.store.add_profile("Sam")
        with self.assertRaises(ValueError):
            self.store.remove_profile("main")  # can't remove the person using it
        self.store.remove_profile("sam")
        self.assertFalse((self.tmp / "users/sam").exists())


class VolumeTests(unittest.TestCase):
    """Volume keys go through lounged, which tells the screen (an open Control Centre follows them)."""

    class FakeActions:
        def __init__(self):
            self.vol = {"level": 40, "muted": False}

        def volume(self):
            return dict(self.vol)

        def set_volume(self, level, muted):
            self.vol = {"level": max(0, min(100, int(level))), "muted": bool(muted)}
            return dict(self.vol)

    def setUp(self):
        import types
        self.srv = types.SimpleNamespace(actions=self.FakeActions(), events=lounged.Events())
        self.q = self.srv.events.subscribe()

    def change(self, body):
        return lounged.Server.change_volume(self.srv, body)

    def test_step_and_event(self):
        self.assertEqual(self.change({"step": 5}), {"level": 45, "muted": False})
        self.assertEqual(self.q.get_nowait(), {"type": "volume", "volume": {"level": 45, "muted": False}})

    def test_limits(self):
        self.srv.actions.vol = {"level": 98, "muted": False}
        self.assertEqual(self.change({"step": 5})["level"], 100)
        self.srv.actions.vol = {"level": 3, "muted": False}
        self.assertEqual(self.change({"step": -5})["level"], 0)

    def test_mute_toggle_and_step_unmutes(self):
        self.assertTrue(self.change({"toggleMute": True})["muted"])
        self.assertEqual(self.change({"step": -5}), {"level": 35, "muted": False})

    def test_slider_still_sets_level(self):
        self.assertEqual(self.change({"level": 70, "muted": False}), {"level": 70, "muted": False})


class AdminUrlTests(unittest.TestCase):
    def srv(self, settings):
        import types
        return types.SimpleNamespace(store=types.SimpleNamespace(settings=lambda: settings))

    def test_override_and_name(self):
        self.assertEqual(lounged.Server.admin_url(self.srv({"remoteAddress": "192.168.1.50:8737"})),
                         "http://192.168.1.50:8737/admin")
        old = lounged.IN_VM
        try:
            lounged.IN_VM = True
            self.assertEqual(lounged.Server.admin_url(self.srv({})), "http://localhost:8737/admin")
            lounged.IN_VM = False
            self.assertTrue(lounged.Server.admin_url(self.srv({})).endswith(".local:8737/admin"))
        finally:
            lounged.IN_VM = old


class IdleTests(unittest.TestCase):
    """lounge-idle: picture off only when idle long enough and nothing is playing (OLED)."""

    @classmethod
    def setUpClass(cls):
        import importlib.util
        from importlib.machinery import SourceFileLoader
        path = str(Path(__file__).resolve().parent.parent / "system/scripts/lounge-idle")
        loader = SourceFileLoader("lounge_idle", path)  # no .py on the name, so say how to load it
        spec = importlib.util.spec_from_loader("lounge_idle", loader)
        cls.idle = importlib.util.module_from_spec(spec)
        loader.exec_module(cls.idle)

    def test_rules(self):
        b = self.idle.should_blank
        self.assertFalse(b(1000, None, 0, False, 15))            # someone is using it
        self.assertFalse(b(1000, 200, 0, False, 15))            # idle 800 s < 15 min
        self.assertTrue(b(1000, 100, 0, False, 15))             # idle 900 s
        self.assertFalse(b(5000, 100, 0, True, 15))             # a video is playing
        self.assertFalse(b(1000, 100, 500, False, 15))          # video stopped 500 s ago
        self.assertTrue(b(1500, 100, 500, False, 15))           # ... and now 1000 s ago
        self.assertFalse(b(99999, 0, 0, False, 0))              # Never


class VirtualKeyboardTests(unittest.TestCase):
    def test_falls_back_without_uinput(self):
        kb = lounged.VirtualKeyboard()
        real_open = lounged.os.open
        def no_uinput(*a, **k):
            raise PermissionError("no access")
        lounged.os.open = no_uinput
        try:
            self.assertFalse(kb.key("up"))      # caller then uses wtype
            self.assertFalse(kb.key("up"))      # and doesn't keep retrying
        finally:
            lounged.os.open = real_open
        self.assertFalse(lounged.VirtualKeyboard().key("not-a-key"))

    def test_every_remote_key_has_a_code(self):
        self.assertEqual(set(lounged.SwayActions.KEYS), set(lounged.VirtualKeyboard.CODES))


class SleepTimerTests(unittest.TestCase):
    def setUp(self):
        import types
        self.srv = types.SimpleNamespace(sleep_at=None, sleep_minutes=0, events=lounged.Events())
        self.srv.sleep_timer = lambda: lounged.Server.sleep_timer(self.srv)
        self.q = self.srv.events.subscribe()

    def test_set_and_clear(self):
        import time as _t
        st = lounged.Server.set_sleep_timer(self.srv, 30)
        self.assertEqual(st["minutes"], 30)
        self.assertAlmostEqual(st["at"], _t.time() + 1800, delta=2)
        self.assertEqual(self.q.get_nowait()["type"], "sleeptimer")
        st = lounged.Server.set_sleep_timer(self.srv, 0)
        self.assertIsNone(st["at"])
        self.assertEqual(st["minutes"], 0)

    def test_refuses_nonsense(self):
        with self.assertRaises(ValueError):
            lounged.Server.set_sleep_timer(self.srv, 5000)
        with self.assertRaises(ValueError):
            lounged.Server.set_sleep_timer(self.srv, -1)


class YouTubePageTests(unittest.TestCase):
    def test_rows_per_channel(self):
        import types
        apps = [{"id": "youtube", "shelf": "youtube", "tvLayout": True}]
        settings = {"youtubeChannels": [{"id": "UCa", "title": "Alpha"}, {"id": "UCbroken", "title": "Broken"}]}
        srv = types.SimpleNamespace(shelf_cache={}, store=types.SimpleNamespace(apps=lambda: apps, settings=lambda: settings))

        def fake_feed(cid):
            if cid == "UCbroken":
                raise OSError("feed down")
            return "Alpha", [{"videoId": f"vid{i:08d}", "title": f"Video {i}", "channel": "Alpha",
                              "published": f"2026-11-{20 - i:02d}", "thumbnail": f"https://i.ytimg.com/vi/vid{i}/hqdefault.jpg"}
                             for i in range(12)]
        real = lounged.youtube_feed
        lounged.youtube_feed = fake_feed
        try:
            page = lounged.Server.youtube_page(srv)
        finally:
            lounged.youtube_feed = real
        self.assertEqual(page["app"], "youtube")
        alpha, broken = page["channels"]
        self.assertEqual(alpha["title"], "Alpha")
        self.assertEqual(len(alpha["videos"]), 8)
        self.assertEqual(alpha["videos"][0]["url"], "https://www.youtube.com/tv#/watch?v=vid00000000")
        self.assertEqual(broken["videos"], [])
        self.assertTrue(broken["error"])


if __name__ == "__main__":
    unittest.main(verbosity=1)
