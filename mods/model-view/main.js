// Model view: a 3D model (STL, STEP, 3MF, OBJ, glTF, ...) in a pane.
//
// A long-lived f3d helper (helper.py, in its own venv) renders each view
// offscreen to a PNG under the app home; this pane shows it. The pane owns the
// camera as absolute values and sends all of it with every request, so a
// dropped request or a helper restart loses nothing. One request at a time:
// while one runs, only the newest camera waits.
//
// Open: pane.split / tab.new with { mod: "model-view", props: { file } }.
// Without a file it lists the models under the focused folder.

import { View, div, image } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { props, theme, settings, notify, exec, appHome, home, focused, readTextFile, watchFolder, nextCommand, checking } from "herdr";

const PORT = 47391;
const STATE = () => `${home()}/.local/share/herdr-model-view`;
const PY = () => `${STATE()}/venv/bin/python`;
const FRAMES = "model-view-frames"; // under the app home, where image() looks
const MODEL = /\.(stl|step|stp|3mf|obj|glb|gltf|ply|off|iges|igs|brep)$/i;
const VIEWS = { iso: [-35, 25], front: [0, 0], back: [180, 0], right: [90, 0], left: [-90, 0], top: [0, 89], bottom: [0, -89] };
const SETUP = [
  "uv venv -p 3.12 ~/.local/share/herdr-model-view/venv && uv pip install -p ~/.local/share/herdr-model-view/venv/bin/python f3d",
  "python3 -m venv ~/.local/share/herdr-model-view/venv && ~/.local/share/herdr-model-view/venv/bin/pip install f3d",
];
const MARK = "herdr-model-view helper"; // in helper.py, to find it if this folder was renamed
const ZOOM = 1.15;
const LAYERS = 4; // helper.py keeps 6 on disk

const base = (p) => p.split("/").pop();
const dir = (p) => p.slice(0, p.lastIndexOf("/")) || "/";
const tilde = (p) => (p && p.startsWith(home()) ? "~" + p.slice(home().length) : p);

export default class ModelView extends View {
  init(_props, cx) {
    this.file = null;
    this.cam = { az: VIEWS.iso[0], el: VIEWS.iso[1], zoom: ZOOM, px: 0, py: 0 };
    this.edges = false;
    this.size = null;      // the view area, logical px
    this.frame = null;     // newest frame, path under the app home
    this.layers = [];      // last few frames, drawn stacked so one is always loaded
    this.error = null;
    this.setup = false;    // the venv is missing
    this.busy = false;
    this.pending = null;   // newest request waiting
    this.drag = null;
    this.settle = 0;       // generation for the full-quality render after a wheel burst
    this.token = null;
    this.list = null;      // the picker's models
    this.ms = null;
    this.readProps(cx);
    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        this.command(c, cx);
        cx.notify();
      }
    });
  }

  readProps(cx) {
    const f = props()?.file;
    if (f && f !== this.file) this.open(f, cx);
  }

  open(file, cx) {
    this.file = file.startsWith("~/") ? home() + file.slice(1) : file;
    this.cam = { az: VIEWS.iso[0], el: VIEWS.iso[1], zoom: ZOOM, px: 0, py: 0 };
    this.frame = null; this.layers = []; this.error = null;
    this.watch(cx);
    this.request(cx, false);
  }

  // Re-render when the file changes on disk (an export from CAD, an agent's edit).
  watch(cx) {
    this.watching?.cancel?.();
    if (checking()) return;
    const file = this.file, folder = dir(file);
    cx.spawn(async (cx) => {
      while (this.file === file) {
        const w = (this.watching = watchFolder(folder));
        let changed;
        try { changed = await w; } catch { await cx.sleep(5000); continue; }
        if (this.file !== file) return;
        if (changed.some((p) => p === file || p === folder)) {
          await cx.sleep(400); // let the writer finish
          this.request(cx, false);
        }
      }
    });
  }

  command(c, cx) {
    const [name, arg] = String(c).split(":");
    const n = parseFloat(arg);
    if (VIEWS[name]) Object.assign(this.cam, { az: VIEWS[name][0], el: VIEWS[name][1] });
    else if (name === "fit") Object.assign(this.cam, { zoom: ZOOM, px: 0, py: 0 });
    else if (name === "orbit" && isFinite(n)) this.cam.az += n;
    else if (name === "tilt" && isFinite(n)) this.cam.el = Math.max(-89, Math.min(89, this.cam.el + n));
    else if (name === "zoom" && isFinite(n) && n > 0) this.cam.zoom = Math.max(0.05, Math.min(50, this.cam.zoom * n));
    else if (name === "edges") this.edges = !this.edges;
    else if (name === "open" && arg) return this.open(String(c).slice(5), cx);
    else if (name === "close") { this.file = null; this.frame = null; this.layers = []; this.watching?.cancel?.(); return; }
    else if (name === "popout") return this.popout();
    else if (name !== "reload") return;
    this.request(cx, false);
  }

  // --- the helper -----------------------------------------------------------

  async post(path, body) {
    if (!this.token) this.token = (await readTextFile(`${STATE()}/token`).catch(() => null))?.trim() || null;
    if (!this.token) throw new Error("no token");
    // curl, not fetch: exec is the transport mods are known to have locally.
    const r = await exec("curl", ["-s", "-m", "60", "-X", "POST", "-H", `X-Token: ${this.token}`,
      "-H", "Content-Type: application/json", "--data-raw", JSON.stringify(body), "-w", "\n%{http_code}",
      `http://127.0.0.1:${PORT}${path}`], { timeout: 65000 });
    const out = r.stdout.trimEnd(), cut = out.lastIndexOf("\n");
    const status = parseInt(out.slice(cut + 1), 10);
    if (r.code !== 0 || !status) throw new Error("helper not reachable");
    const j = JSON.parse(out.slice(0, cut) || "{}");
    if (status === 403) { this.token = null; throw new Error("token"); }
    if (status !== 200) throw Object.assign(new Error(j.error || `HTTP ${status}`), { fromHelper: true });
    return j;
  }

  async ensure(cx) {
    try { await this.post("/ping", {}); return true; } catch {}
    const ok = await exec("test", ["-x", PY()]).then((r) => r.code === 0).catch(() => false);
    if (!ok) { this.setup = true; return false; }
    this.setup = false;
    const helper = await this.helperPath();
    if (!helper) throw new Error("helper.py is missing from the mod folder");
    await exec("sh", ["-c", 'mkdir -p "$4"; nohup "$1" -I "$2" "$3" "$4" >"$4/helper.log" 2>&1 </dev/null &',
      "sh", PY(), helper, `${appHome()}/${FRAMES}`, STATE()]);
    for (let i = 0; i < 40; i++) {
      await cx.sleep(250);
      this.token = null;
      try { await this.post("/ping", {}); return true; } catch {}
    }
    return false;
  }

  // mods/model-view/helper.py, or the helper.py of this mod under another name.
  async helperPath() {
    if (this.helper) return this.helper;
    const r = await exec("sh", ["-c", 'for f in "$1"/model-view/helper.py "$1"/*/helper.py; do grep -qs "$2" "$f" && { printf %s "$f"; exit; }; done',
      "sh", `${appHome()}/mods`, MARK]).catch(() => null);
    return (this.helper = r?.stdout.trim() || null);
  }

  // fast: while dragging or scrolling, 0.75x the pane's logical size, JPG, no
  // ambient occlusion. Still frames: 2x (Retina), PNG, ambient occlusion.
  request(cx, fast) {
    if (!this.file || !this.size || checking()) return;
    const scale = fast ? 0.75 : 2; // drag: under half the screen's pixels
    this.pending = {
      file: this.file, ...this.cam, edges: this.edges, fast,
      w: Math.round(this.size.width * scale), h: Math.round(this.size.height * scale),
    };
    if (this.busy) return;
    this.busy = true;
    cx.spawn(async (cx) => {
      try {
        while (this.pending) {
          const q = this.pending; this.pending = null;
          let r;
          try { r = await this.post("/render", q); }
          catch (e) {
            if (e.fromHelper) throw e;
            if (!(await this.ensure(cx))) throw new Error(this.setup ? "setup" : "The render helper did not start");
            r = await this.post("/render", q);
          }
          if (q.file !== this.file) continue;
          this.frame = `${FRAMES}/${r.frame}`; this.ms = r.ms; this.error = null;
          const now = Date.now();
          this.stamps = [...(this.stamps || []).filter((s) => now - s < 1000), now];
          this.fps = q.fast ? this.stamps.length : null;
          // An image loads after it is first drawn and shows nothing until then:
          // keep the frames before it underneath, newest on top.
          this.layers = [...this.layers, this.frame].slice(-LAYERS);
          cx.notify();
        }
      } catch (e) {
        this.error = String(e.message || e);
        cx.notify();
      } finally { this.busy = false; }
    });
  }

  // --- the picker -------------------------------------------------------------

  loadList(cx) {
    if (this.list || checking()) return;
    this.list = [];
    const root = focused()?.cwd || home();
    this.listRoot = root;
    cx.spawn(async (cx) => {
      const r = await exec("find", [root, "-maxdepth", "4", "-type", "f", "-not", "-path", "*/.*", "-not", "-path", "*/node_modules/*"]).catch(() => null);
      this.list = (r?.stdout || "").split("\n").filter((p) => MODEL.test(p)).sort().slice(0, 200);
      cx.notify();
    });
  }

  // --- drawing ----------------------------------------------------------------

  button(id, label, onClick, on = false) {
    const t = theme();
    return div().id(id).h(24).px(8).flex().items_center().rounded(5).text_size(12)
      .border(1).border_color(on ? t.accent : t.border).bg(on ? t.selected : t.background)
      .text_color(on ? t.foreground : t.muted).hover((s) => s.bg(t.hover)).cursor_pointer()
      .on_click((_e, cx) => { onClick(cx); cx.notify(); }).child(label);
  }

  picker(t) {
    const rows = this.list || [];
    return v_flex().size_full().bg(t.background).p(16).gap(6).text_size(13).overflow_y_scrollbar()
      .child(div().font_semibold().text_color(t.foreground).child("Open a 3D model"))
      .child(div().text_size(11.5).text_color(t.dim).child(`STL, STEP, 3MF, OBJ, glTF under ${tilde(this.listRoot || "")}`))
      .children(rows.length ? rows.map((p, i) =>
        div().id(`m-${i}`).px(8).py(5).rounded(6).truncate().cursor_pointer().hover((s) => s.bg(t.hover))
          .on_click((_e, cx) => { this.open(p, cx); cx.notify(); })
          .child(div().text_color(t.foreground).child(base(p)))
          .child(div().text_size(11).text_color(t.dim).truncate().child(tilde(dir(p))))) :
        [div().text_color(t.dim).child(this.list ? "No models found here." : "Looking…")]);
  }

  view(t) {
    return div().id("mv-area").relative().flex_1().min_h(0).w_full().overflow_hidden().bg(t.canvas)
      .on_size_change((size, cx) => {
        const first = !this.size;
        this.size = { width: Math.max(64, Math.floor(size.width)), height: Math.max(64, Math.floor(size.height)) };
        this.request(cx, false);
        if (first) cx.notify();
      })
      .on_mouse_down("left", (e, cx) => { this.drag = { x: e.position.x, y: e.position.y, pan: e.modifiers.shift || e.modifiers.alt }; })
      .on_mouse_down("right", (e, cx) => { this.drag = { x: e.position.x, y: e.position.y, pan: true }; })
      .on_mouse_move((e, cx) => {
        const d = this.drag;
        if (!d) return;
        const dx = e.position.x - d.x, dy = e.position.y - d.y;
        if (!dx && !dy) return;
        d.x = e.position.x; d.y = e.position.y;
        if (d.pan) {
          const k = 4 / (this.size.height * this.cam.zoom);
          this.cam.px -= dx * k; this.cam.py += dy * k;
        } else {
          this.cam.az -= dx * 0.4;
          this.cam.el = Math.max(-89, Math.min(89, this.cam.el + dy * 0.4));
        }
        this.request(cx, true);
      })
      .on_mouse_up("left", (_e, cx) => this.endDrag(cx))
      .on_mouse_up("right", (_e, cx) => this.endDrag(cx))
      .on_hover((on, cx) => { if (!on) this.endDrag(cx); })
      .on_scroll_wheel((e, cx) => {
        const dy = e.delta_lines ? e.delta_lines.y * 40 : e.delta.y;
        this.cam.zoom = Math.max(0.05, Math.min(50, this.cam.zoom * Math.exp(dy * 0.004)));
        this.later(cx);
      })
      .on_pinch((e, cx) => {
        this.cam.zoom = Math.max(0.05, Math.min(50, this.cam.zoom * (1 + e.delta)));
        this.later(cx);
      })
      .on_click((e, cx) => { if (e.click_count === 2) { Object.assign(this.cam, { zoom: ZOOM, px: 0, py: 0 }); this.request(cx, false); } })
      .when(!!this.frame && !!this.size, (el) => el.children(this.layers.map((f) =>
        image(f).absolute().top(0).left(0).w(this.size.width).h(this.size.height))))
      .when(!this.frame && !this.error, (el) => el.child(
        h_flex().size_full().items_center().justify_center().text_size(12.5).text_color(t.dim).child(`Rendering ${base(this.file)}…`)));
  }

  // The same model in f3d's own window: real-time GPU, outside the Herdr window.
  popout() {
    if (!this.file || checking()) return;
    exec("sh", ["-c", 'command -v f3d >/dev/null || exit 3; nohup f3d "$1" --up=+Z --grid --anti-aliasing >/dev/null 2>&1 </dev/null &', "sh", this.file])
      .then((r) => { if (r.code === 3) notify({ title: "f3d is not installed", body: "brew install f3d", level: "warning" }); });
  }

  endDrag(cx) {
    if (!this.drag) return;
    this.drag = null;
    this.request(cx, false);
  }

  // A wheel burst: fast frames now, one full frame once it stops.
  later(cx) {
    this.request(cx, true);
    const g = ++this.settle;
    cx.timer.after(250, (cx) => { if (g === this.settle) this.request(cx, false); });
  }

  render(cx) {
    this.readProps(cx);
    const t = theme();
    if (!this.file) { this.loadList(cx); return this.picker(t); }
    const views = ["iso", "front", "top", "right"];
    const err = this.error === "setup"
      ? [div().font_semibold().text_color(t.foreground).child("The 3D helper is not set up"),
         div().text_color(t.muted).child("Run one of these once in a terminal (uv, or plain Python 3.11+), then Reload:"),
         ...SETUP.map((c) => div().font_family(settings().font_family).text_size(11.5).text_color(t.foreground).bg(t.raised).p(8).rounded(6).child(c))]
      : [div().text_color(t.ansi1).child(this.error || "")];
    return v_flex().id("root").size_full().bg(t.background).text_size(12.5)
      .child(h_flex().h(38).flex_none().px(10).gap(6).items_center().border_b(1).border_color(t.border).bg(t.chrome)
        .child(div().min_w(0).flex_1().truncate()
          .child(div().font_semibold().text_color(t.foreground).truncate().child(base(this.file))))
        .children(views.map((v) => this.button(`v-${v}`, v[0].toUpperCase() + v.slice(1), (cx) => this.command(v, cx))))
        .child(this.button("fit", "Fit", (cx) => this.command("fit", cx)))
        .child(this.button("edges", "Edges", (cx) => this.command("edges", cx), this.edges))
        .child(this.button("reload", "Reload", (cx) => this.command("reload", cx)))
        .child(this.button("popout", "Pop out", (cx) => this.command("popout", cx)))
        .child(this.button("open", "Open…", (cx) => { this.command("close", cx); this.list = null; })))
      .child(this.error ? v_flex().flex_1().p(20).gap(8).children(err) : this.view(t))
      .child(h_flex().h(24).flex_none().px(10).gap(12).items_center().border_t(1).border_color(t.border).bg(t.chrome)
        .text_size(11).text_color(t.dim)
        .child(div().flex_1().truncate().child(tilde(dir(this.file))))
        .child(div().child("drag orbit · shift/right-drag pan · scroll zoom · double-click fit"))
        .child(div().child(this.fps ? `${this.fps} fps` : this.ms != null ? `${this.ms} ms` : "")));
  }
}
