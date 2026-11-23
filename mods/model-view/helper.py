"""Render helper for the model-view Herdr mod (herdr-model-view helper).

One long-lived f3d engine, offscreen. The mod asks for a frame over HTTP on
127.0.0.1 with a token, and shows the PNG this writes. Every request carries
the whole camera (absolute angles), so a dropped request or a restart loses
nothing. Single-threaded: every f3d call runs on this one thread.

    python -I helper.py <frames dir> <state dir>

Exits when another helper already holds the port, and after IDLE seconds
without a request.
"""
import http.server, json, math, os, secrets, sys, time

PORT = 47391
IDLE = 15 * 60
KEEP = 6  # frames kept on disk; older ones are deleted
EXTS = (".stl", ".step", ".stp", ".3mf", ".obj", ".glb", ".gltf", ".ply", ".off", ".iges", ".igs", ".brep")

frames, state = sys.argv[1], sys.argv[2]
os.makedirs(frames, exist_ok=True)
os.makedirs(state, exist_ok=True)

import f3d  # noqa: E402  (slow import: after argument checks)

f3d.Engine.autoload_plugins()
engine = f3d.Engine.create(True)
o = engine.options
o["scene.up_direction"] = [0.0, 0.0, 1.0]
o["render.grid.enable"] = True
o["render.grid.absolute"] = False
o["render.effect.ambient_occlusion"] = True
o["render.effect.antialiasing.mode"] = "fxaa"
o["render.effect.tone_mapping"] = True
o["render.hdri.ambient"] = False
o["model.coloring"] = "material"

loaded = {"file": None, "mtime": None, "center": None, "radius": None}
seq = 0
last = time.time()


def load(path):
    st = os.stat(path)
    if loaded["file"] == path and loaded["mtime"] == st.st_mtime:
        return
    engine.scene.clear()
    engine.scene.add(path)
    cam = engine.window.camera
    cam.reset_to_bounds()
    s = cam.state
    c = list(s.focal_point)
    d = math.dist(s.position, c)
    # reset_to_bounds frames the model at view_angle; the distance it picks
    # stands for the model's size.
    loaded.update(file=path, mtime=st.st_mtime, center=c, radius=d)


def render(q):
    path = os.path.realpath(os.path.expanduser(str(q["file"])))
    if not path.lower().endswith(EXTS):
        raise ValueError("not a model file")
    if not os.path.isfile(path):
        raise FileNotFoundError(path)
    load(path)
    w = max(64, min(4096, int(q.get("w", 800))))
    h = max(64, min(4096, int(q.get("h", 600))))
    az = math.radians(float(q.get("az", 45)))
    el = math.radians(max(-89.0, min(89.0, float(q.get("el", 25)))))
    zoom = max(0.05, min(50.0, float(q.get("zoom", 1))))
    px, py = float(q.get("px", 0)), float(q.get("py", 0))
    c, r = loaded["center"], loaded["radius"] / zoom
    # Z up. Azimuth 0 looks from -Y (front), 90 from +X (right).
    dirv = (math.cos(el) * math.sin(az), -math.cos(el) * math.cos(az), math.sin(el))
    # Camera-plane axes for panning, in units of the model's size.
    right = (math.cos(az), math.sin(az), 0.0)
    up = (-math.sin(el) * math.sin(az), math.sin(el) * math.cos(az), math.cos(el))
    k = loaded["radius"] * 0.5
    f = [c[i] + (right[i] * px + up[i] * py) * k for i in range(3)]
    pos = [f[i] + dirv[i] * r for i in range(3)]
    o["render.effect.ambient_occlusion"] = not q.get("fast")
    o["render.show_edges"] = bool(q.get("edges"))
    engine.window.size = (w, h)
    engine.window.camera.state = f3d.CameraState(pos, f, up, 30.0)
    global seq
    seq += 1
    # Drag frames: JPG, a little faster to write and to decode. Still frames: PNG.
    fast = bool(q.get("fast"))
    name = f"f-{os.getpid()}-{seq}.{'jpg' if fast else 'png'}"
    engine.window.render_to_image().save(os.path.join(frames, name), f3d.Image.SaveFormat.JPG if fast else f3d.Image.SaveFormat.PNG)
    for old in sorted(os.listdir(frames), key=lambda n: os.path.getmtime(os.path.join(frames, n)))[:-KEEP]:
        try:
            os.remove(os.path.join(frames, old))
        except OSError:
            pass
    return {"frame": name, "file": path}


class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def reply(self, code, body):
        data = json.dumps(body).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_POST(self):
        global last
        last = time.time()
        if self.headers.get("X-Token") != TOKEN:
            return self.reply(403, {"error": "bad token"})
        try:
            n = int(self.headers.get("Content-Length") or 0)
            q = json.loads(self.rfile.read(min(n, 65536)) or b"{}")
            if self.path == "/ping":
                return self.reply(200, {"ok": True, "pid": os.getpid()})
            if self.path == "/render":
                t = time.time()
                out = render(q)
                out["ms"] = round((time.time() - t) * 1000)
                return self.reply(200, out)
            self.reply(404, {"error": "unknown path"})
        except Exception as e:  # noqa: BLE001  report every failure to the mod
            self.reply(500, {"error": f"{type(e).__name__}: {e}"})


try:
    server = http.server.HTTPServer(("127.0.0.1", PORT), Handler)
except OSError:
    sys.exit(0)  # another helper already serves

TOKEN = secrets.token_hex(16)
tok = os.path.join(state, "token")
fd = os.open(tok + ".tmp", os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
os.write(fd, TOKEN.encode())
os.close(fd)
os.replace(tok + ".tmp", tok)

server.timeout = 30
while time.time() - last < IDLE:
    server.handle_request()
server.server_close()
for n in os.listdir(frames):
    try:
        os.remove(os.path.join(frames, n))
    except OSError:
        pass
