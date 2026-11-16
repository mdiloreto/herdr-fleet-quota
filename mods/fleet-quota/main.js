// Read each host's Omarchy quota over its existing Herdr connection.
import { View, div, svg } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { checking, closeOverlay, exec, hc, props, openOverlay, theme } from "herdr";
import { collectFleet } from "./fleet.js";
import { READ_SCRIPT } from "./model.js";

// A read a minute: quota windows move by the hour, and every read is an exec
// on each machine.
const REFRESH_MS = 60000;
const READ_TIMEOUT_MS = 8000;
const CONCURRENCY = 4;
// Space for the quota badge beside the tabs.
const BAR_WIDTH = 118;

// Bundled with the mod, so the widget keeps its own outline icons.
const ICON = {
  gauge: "mods/fleet-quota/icons/gauge.svg",
  desktop: "mods/fleet-quota/icons/desktop.svg",
  server: "mods/fleet-quota/icons/server.svg",
  refresh: "mods/fleet-quota/icons/refresh.svg",
  close: "mods/fleet-quota/icons/close.svg",
  chevron: "mods/fleet-quota/icons/chevron-right.svg",
  clock: "mods/fleet-quota/icons/clock.svg",
  provider: "mods/fleet-quota/icons/provider.svg",
};

// Known providers read as names people recognise. The icons are Herdr's own
// program glyphs, drawn tinted; a provider we don't know keeps its text id and
// the generic outline.
const PROVIDERS = {
  claude: { name: "Claude", icon: "icons/claude.svg", color: "ansi3" },
  codex: { name: "Codex", icon: "icons/codex.svg", color: "ansi6" },
  copilot: { name: "GitHub Copilot", icon: "icons/copilot.svg", color: "ansi5" },
  agy: { name: "Antigravity", icon: "icons/antigravity.svg", color: "ansi13" },
  gemini: { name: "Gemini", icon: "icons/gemini.svg", color: "ansi6" },
  openrouter: { name: "OpenRouter", icon: ICON.provider, color: "ansi4" },
  fireworks: { name: "Fireworks", icon: ICON.provider, color: "ansi3" },
};

// The remote machines `hc machine ls --json` lists. collectFleet adds this
// computer itself, first, so this listing never has to. A listing that fails
// throws, so collectFleet keeps the reading it had.
async function listMachines() {
  const r = await hc(["machine", "ls", "--json"]);
  if (!r || r.code !== 0) throw new Error("Couldn't list machines.");
  let answer;
  try {
    answer = JSON.parse(r.stdout);
  } catch {
    throw new Error("Couldn't read the machine list.");
  }
  if (!Array.isArray(answer?.machines)) throw new Error("Couldn't read the machine list.");
  return answer.machines;
}

// One machine's reading. Its name never reaches the shell: `on` picks the
// machine, so a name with quotes or spaces cannot change the script. A failure
// says nothing of stderr, which can carry paths and credentials.
function readHost(name) {
  return exec("sh", ["-c", READ_SCRIPT], { on: name, timeout: READ_TIMEOUT_MS });
}

function percentOf(used) {
  if (typeof used !== "number" || !Number.isFinite(used)) return null;
  return Math.round(Math.min(100, Math.max(0, used)));
}

function parseTime(value) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number" && (!Number.isFinite(value) || value <= 0)) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function shortDate(date) {
  return `${MONTHS[date.getMonth()]} ${date.getDate()}`;
}

// Date getters keep labels compact even on runtimes without Intl options.
function relativeTime(date, now) {
  if (!date) return null;
  const diff = now - date.getTime();
  if (!Number.isFinite(diff)) return null;
  if (diff < 0) return "future timestamp";
  if (diff < 60000) return "just now";
  const minutes = Math.floor(diff / 60000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return shortDate(date) + (date.getFullYear() !== new Date(now).getFullYear() ? ` ${date.getFullYear()}` : "");
}

// Unknown and elapsed resets remain distinct from a future reset.
function resetLabel(resetsAt, now = Date.now()) {
  const when = parseTime(resetsAt);
  if (!when) return "?";
  if (when.getTime() <= now) return "passed";
  const today = new Date(now);
  const sameDay = when.toDateString() === today.toDateString();
  const time = `${String(when.getHours()).padStart(2, "0")}:${String(when.getMinutes()).padStart(2, "0")}`;
  return sameDay ? time : `${shortDate(when)} · ${time}`;
}

// Keep the exact timestamp available without stretching the row.
function stamp(t, value, prefix, now) {
  const date = parseTime(value);
  const relative = relativeTime(date, now);
  if (!relative) return null;
  return div()
    .text_size(11)
    .text_color(t.muted)
    .tooltip(date.toLocaleString())
    .child(`${prefix} ${relative}`);
}

function icon(path, size, color) {
  return svg(path).w(size).h(size).flex_none().text_color(color);
}

function pill(t, text, color) {
  return h_flex()
    .flex_none()
    .items_center()
    .h(18)
    .px(6)
    .rounded(8)
    .bg(t.surface)
    .border(1)
    .border_color(color)
    .child(div().text_size(10).text_color(color).child(text));
}

// What each host status says, and what it leaves unsaid.
const STATUS = {
  ok: { word: "read", empty: "No quota windows in its reading." },
  "no-data": { word: "no data", empty: "No quota data reported on this machine." },
  offline: { word: "offline", empty: "Not answering; nothing was read." },
  error: { word: "error", empty: "The reading failed." },
};

function statusOf(host) {
  return STATUS[host?.status] ?? STATUS.error;
}

function statusColor(t, status) {
  if (status === "ok") return t.done;
  if (status === "error") return t.blocked;
  return t.muted;
}

function providerOf(id) {
  return Object.prototype.hasOwnProperty.call(PROVIDERS, id) ? PROVIDERS[id] : null;
}

function providerName(id) {
  return providerOf(id)?.name ?? (id || "unknown");
}

function providerIcon(id) {
  return providerOf(id)?.icon ?? ICON.provider;
}

function providerColor(t, id) {
  return t[providerOf(id)?.color] ?? t.accent;
}

function usageColor(t, pct, color) {
  return pct >= 95 ? t.blocked : pct >= 80 ? t.working : color;
}

function tile(t, path, color, size = 28) {
  return h_flex().size(size).flex_none().items_center().justify_center()
    .rounded(7).bg(color).child(icon(path, size - 12, t.canvas));
}

export default class FleetQuota extends View {
  init(_props, cx) {
    this.hosts = [];
    this.discoveryError = null;
    this.failure = null;
    this.loading = false;
    this.refreshedAt = 0;
    // `herdr-app check` runs init for real: no timer, no hc, no exec, no network.
    if (checking()) return;
    this.refresh(cx);
    cx.timer.every(REFRESH_MS, (cx) => this.refresh(cx));
  }

  // One read at a time: a machine that hangs must not stack a minute's timers.
  refresh(cx) {
    if (this.loading) return;
    this.loading = true;
    cx.spawn(async (cx) => {
      try {
        const { hosts, discoveryError } = await collectFleet({
          listMachines,
          readHost,
          previous: this.hosts,
          now: Date.now(),
          concurrency: CONCURRENCY,
        });
        this.hosts = Array.isArray(hosts) ? hosts : [];
        this.discoveryError = discoveryError ? String(discoveryError) : null;
        this.failure = null;
        this.refreshedAt = Date.now();
      } catch {
        // What was shown stays; the notice says this read didn't land.
        this.failure = "Couldn't read the fleet.";
      } finally {
        this.loading = false;
        cx.notify();
      }
    });
  }

  summary() {
    const known = this.hosts.length;
    const read = this.hosts.filter((h) => h.status === "ok").length;
    const readings = this.hosts.flatMap((host) => (host.rows ?? [])
      .filter((row) => percentOf(row.used) !== null)
      .map((row) => ({ host, row })));
    const highest = readings.reduce((best, item) => !best || item.row.used > best.row.used ? item : best, null);
    const old = highest && (highest.row.stale || highest.host.status !== "ok");
    const incomplete = !!this.discoveryError || !!this.failure || this.hosts.some((host) =>
      host.status !== "ok" || host.errors > 0 || (host.rows ?? []).some((row) =>
        row.used === null || (row.windows ?? []).some((window) => window.used === null)));
    return { known, read, highest, old, incomplete };
  }

  // Highest reported, never a fleet total. Clickable even before the first read.
  bar(t) {
    const { known, read, highest, old, incomplete } = this.summary();
    const value = `${highest ? `${percentOf(highest.row.used)}%${old ? "~" : ""}` : "—"}${incomplete ? "!" : ""}`;
    const account = highest?.row.accountLabel ? ` · ${highest.row.accountLabel}` : "";
    const label = highest
      ? `Highest reported quota used: ${value} on ${highest.host.label}, ${highest.row.id}${account}. ${read} of ${known} machines with readings. Values are not added.${incomplete ? " Some machines or quota percentages are unavailable." : ""}`
      : `Fleet quota: ${read} of ${known} machines with readings. No percentage available.${incomplete ? " Some machines or quota percentages are unavailable." : ""}`;
    const dot = incomplete ? (t.working ?? t.dim) : known && read === known ? t.done : t.dim;
    return h_flex()
      .id("fleet-quota-bar")
      .h_full()
      .w(BAR_WIDTH)
      .px(7)
      .gap(4)
      .items_center()
      .flex_none()
      .bg(t.chrome)
      .border_b(1)
      .border_color(t.border)
      .hover((s) => s.bg(t.hover))
      .role("button")
      .accessibility_label(`${label} Open the fleet detail.`)
      .tooltip(label)
      .on_mouse_down("left", (_event, cx) => cx.stop_propagation())
      .on_click((_event, cx) => { cx.stop_propagation(); this.open(); })
      .child(icon(ICON.gauge, 13, dot))
      .child(div().flex_1().min_w(0).truncate().text_size(12).font_semibold().text_color(t.foreground).child(`AI ${value}`))
      .child(icon(ICON.chevron, 10, t.dim));
  }

  open() {
    openOverlay({
      mod: "fleet-quota",
      kind: "dialog",
      width: 620,
      height: 560,
      props: { part: "panel" },
    });
  }

  render() {
    const t = theme();
    return props()?.part === "bar" ? this.bar(t) : this.panel(t);
  }

  panel(t) {
    const now = Date.now();
    const summary = this.summary();
    return v_flex()
      .id("fleet-quota-panel")
      .size_full()
      .min_w(0)
      .bg(t.canvas)
      .p(14)
      .gap(12)
      .text_size(13)
      .text_color(t.foreground)
      .child(
        h_flex().id("fleet-heading").flex_none().items_center().gap(10)
          .child(tile(t, ICON.gauge, t.accent, 34))
          .child(
            v_flex().flex_1().min_w(0).gap(1)
              .child(div().text_size(20).font_semibold().child("Fleet quota"))
              .child(div().text_size(11).text_color(t.muted)
                .child(this.loading ? "Reading saved quota records…" : "AI usage · per machine, per account")),
          )
          .child(
            h_flex().gap(2).items_center().flex_none()
              .child(this.iconButton(t, "fleet-refresh", ICON.refresh, "Reread saved quota records",
                (_event, cx) => this.refresh(cx), this.loading))
              .child(this.iconButton(t, "fleet-close", ICON.close, "Close fleet quota",
                () => closeOverlay(props().overlay), false)),
          ),
      )
      .child(this.overview(t, summary, now))
      .when(Boolean(this.failure || this.discoveryError), (el) =>
        el.child(this.notice(t)),
      )
      .child(
        v_flex()
          .id("fleet-hosts")
          .flex_1()
          .min_h(0)
          .min_w(0)
          .gap(10)
          .overflow_y_scrollbar()
          .when(!summary.known, (el) => el.child(this.empty(t)))
          .children(this.hosts.map((host, index) => this.host(t, host, index, now))),
      )
      .child(
        div().flex_none().border_t(1).border_color(t.border).pt(8)
          .text_size(11)
          .text_color(t.muted)
          .child(
            "Machines can share one account; nothing here is added up. Old = saved reading · ! = missing coverage.",
          ),
      );
  }

  overview(t, { known, read, highest, old, incomplete }, now) {
    const pct = highest ? percentOf(highest.row.used) : null;
    const color = highest ? usageColor(t, pct, providerColor(t, highest.row.id)) : t.muted;
    const source = highest
      ? `${providerName(highest.row.id)} · ${highest.host.label}${highest.row.accountLabel ? ` · ${highest.row.accountLabel}` : ""}`
      : "No percentage available";
    return h_flex().id("fleet-overview").flex_none().min_w(0).gap(10)
      .child(v_flex().id("fleet-highest").flex_1().min_w(0).gap(3)
        .p(10).rounded(8).bg(t.surface).border_l(3).border_color(color)
        .child(div().text_size(10).text_color(t.muted).child("HIGHEST REPORTED USAGE"))
        .child(h_flex().gap(8).items_center().flex_wrap()
          .child(div().text_size(24).font_semibold().text_color(color).child(pct === null ? "—" : `${pct}%`))
          .when(pct !== null, (el) => el.child(pill(t, old ? "old" : "current", old ? t.working : t.done))))
        .child(div().text_size(11).min_w(0).truncate().tooltip(source).accessibility_label(source)
          .text_color(t.muted).child(source)))
      .child(v_flex().id("fleet-coverage").flex_1().min_w(0).gap(3)
        .p(10).rounded(8).bg(t.surface).border_l(3).border_color(incomplete ? t.working : t.accent)
        .child(div().text_size(10).text_color(t.muted).child("MACHINES WITH READINGS"))
        .child(h_flex().gap(8).items_center().flex_wrap()
          .child(div().text_size(24).font_semibold().child(`${read} / ${known}`))
          .when(incomplete, (el) => el.child(pill(t, "! incomplete", t.working))))
        .child(stamp(t, this.refreshedAt, "checked", now)
          ?? div().text_size(11).text_color(t.muted).child("No machines read yet")));
  }

  iconButton(t, id, path, label, onClick, busy) {
    return h_flex()
      .id(id)
      .role("button")
      .accessibility_label(label)
      .tooltip(label)
      .flex_none()
      .items_center()
      .justify_center()
      .w(28)
      .h(28)
      .rounded(6)
      .bg(t.surface)
      .border(1).border_color(t.border)
      .cursor_pointer()
      .hover((s) => s.bg(t.hover))
      .on_click(onClick)
      .child(icon(path, 14, busy ? t.working : t.muted));
  }

  empty(t) {
    return h_flex()
      .id("fleet-empty")
      .gap(8)
      .items_center()
      .p(10)
      .rounded(8)
      .bg(t.raised)
      .border(1)
      .border_color(t.border)
      .child(icon(ICON.gauge, 16, t.dim))
      .child(
        v_flex()
          .gap(1)
          .min_w(0)
          .child(div().text_size(12).text_color(t.muted).child("No machines read yet"))
          .child(div().text_size(11).text_color(t.dim)
            .child(this.loading
              ? "Reading the fleet…"
              : this.failure || this.discoveryError ? "The next read tries again." : "The next read fills this list.")),
      );
  }

  // A failed listing or read: what was read before stays on screen, said plainly.
  notice(t) {
    const text = this.failure ?? "Couldn't list every machine; showing what was read before.";
    return h_flex()
      .id("fleet-notice")
      .gap(6)
      .p(8)
      .rounded(6)
      .bg(t.raised)
      .border(1)
      .border_color(t.border)
      .child(div().text_size(12).text_color(t.blocked).child(text));
  }

  host(t, host, hostIndex, now) {
    const status = statusOf(host);
    const rows = Array.isArray(host?.rows) ? host.rows : [];
    const earlier = host?.status !== "ok" && rows.length > 0;
    const read = rows.length ? stamp(t, host?.lastSuccessAt, "read", now) : null;
    const label = host?.label || host?.name || "This computer";
    return v_flex()
      .id(`fleet-host-${hostIndex}`)
      .flex_none().min_w(0)
      .gap(8)
      .p(rows.length ? 10 : 8)
      .rounded(8)
      .bg(t.surface)
      .border(1)
      .border_color(t.border)
      .child(
        h_flex().gap(8).items_center().min_w(0)
          .child(icon(host?.name == null ? ICON.desktop : ICON.server, 16, rows.length ? t.accent : t.muted))
          .child(v_flex().flex_1().min_w(0).gap(2)
            .child(div().font_semibold().truncate().tooltip(label).accessibility_label(label).child(label))
            .when(!rows.length, (el) => el.child(div().text_size(11).text_color(t.muted)
              .child(host?.reason || status.empty))))
          .child(pill(t, status.word, statusColor(t, host?.status)))
      )
      .when(Boolean(read || earlier || Number(host?.errors) > 0), (el) => el.child(
        h_flex().gap(6).flex_wrap().items_center()
          .when(Boolean(read), (inner) => inner.child(read))
          .when(earlier, (inner) => inner.child(pill(t, "old reading", t.working)))
          .when(Number(host?.errors) > 0, (inner) =>
            inner.child(pill(t, `${host.errors} unreadable or omitted`, t.working)))))
      .when(Boolean(rows.length && host?.reason), (el) =>
        el.child(div().text_size(11).text_color(t.dim).child(host.reason)))
      .when(Number(host?.truncated) > 0, (el) =>
        el.child(div().text_size(11).text_color(t.dim).child("Some accounts omitted: limit 16 per provider.")))
      .when(Number(host?.truncatedWindows) > 0, (el) =>
        el.child(div().text_size(11).text_color(t.dim).child("Some quota windows omitted: limit 20 per account.")))
      .children(rows.map((row, index) => this.provider(t, row, hostIndex, index, now, earlier)));
  }

  // One provider or account on one machine, under its own windows.
  provider(t, row, hostIndex, rowIndex, now, earlier = false) {
    const windows = Array.isArray(row?.windows) ? row.windows : [];
    const updated = stamp(t, row?.updatedAt, "record", now);
    const color = providerColor(t, row?.id);
    const stale = earlier || Boolean(row?.stale);
    const name = providerName(row?.id);
    return v_flex()
      .id(`fleet-provider-${hostIndex}-${rowIndex}`)
      .flex_none().min_w(0).gap(7).p(8).rounded(7)
      .bg(t.raised).border_l(3).border_color(color)
      .child(
        h_flex().gap(8).items_center().min_w(0)
          .child(tile(t, providerIcon(row?.id), color))
          .child(v_flex().flex_1().min_w(0).gap(2)
            .child(div().font_semibold().text_color(color).min_w(0).truncate()
              .tooltip(name).accessibility_label(name).child(name))
            .when(Boolean(row?.accountLabel), (el) => el.child(div().text_size(11).text_color(t.muted)
              .min_w(0).truncate().tooltip(row.accountLabel).accessibility_label(row.accountLabel).child(row.accountLabel)))
            .child(updated ?? div().text_size(11).text_color(t.muted).child("Record time unknown")))
          .child(pill(t, stale ? "old" : "current", stale ? t.working : t.done)),
      )
      .when(Boolean(row?.accountActive || row?.incomplete), (el) => el.child(h_flex().gap(6).items_center().flex_wrap().min_w(0)
        .when(Boolean(row?.accountActive), (el) => el.child(pill(t, "active", color)))
        .when(Boolean(row?.incomplete), (el) => el.child(pill(t, "incomplete", t.working)))))
      .when(!windows.length, (el) => el.child(div().text_size(11).text_color(t.dim).child("No quota reported.")))
      .children(windows.map((w, index) => this.window(t, w, row, hostIndex, rowIndex, index, now, stale)));
  }

  window(t, w, row, hostIndex, rowIndex, windowIndex, now, stale = Boolean(row?.stale)) {
    const pct = percentOf(w?.used);
    const balance = Boolean(w?.isBalance);
    const reset = balance ? null : resetLabel(w?.resetsAt, now);
    const resetAt = parseTime(w?.resetsAt);
    const label = w?.label ?? "—";
    const reading = pct === null ? (balance ? "no percentage" : "? used") : `${pct}% used`;
    const clip = `${pct === null
      ? (balance ? "no percentage available" : "percentage unavailable, not zero")
      : `${pct} percent used`}${stale ? ", from an earlier reading" : ""}`;
    const color = usageColor(t, pct, providerColor(t, row?.id));
    const resetText = reset === "passed" ? "reset passed" : `resets ${reset}`;
    return v_flex()
      .id(`fleet-window-${hostIndex}-${rowIndex}-${windowIndex}`)
      .gap(3).min_w(0)
      .child(h_flex().gap(8).items_center().min_w(0)
        .child(div().flex_1().min_w(0).truncate().text_size(12).tooltip(label).accessibility_label(label).child(label))
        .child(div().id(`fleet-window-pct-${hostIndex}-${rowIndex}-${windowIndex}`)
          .w(100).flex_none().text_right().text_size(12).font_semibold()
          .text_color(pct === null ? t.muted : color).child(reading)))
      .child(h_flex().gap(10).items_center().min_w(0).child(
        h_flex()
          .id(`fleet-window-track-${hostIndex}-${rowIndex}-${windowIndex}`)
          .flex_1().min_w(0)
          .h(6)
          .rounded(3)
          .items_center()
          .overflow_hidden()
          .bg(t.border)
          .role("progress_indicator")
          .accessibility_label(`${label}: ${clip}`)
          .when(pct !== null, (el) =>
            el.child(div()
              .id(`fleet-window-fill-${hostIndex}-${rowIndex}-${windowIndex}`)
              .h_full()
              .flex_none()
              .w(`${pct}%`)
              .rounded(3)
              .bg(color).opacity(stale ? 0.75 : 1))),
      )
        .child(div().w(142).flex_none().text_right().text_size(10).text_color(t.muted)
          .tooltip(balance ? "Prepaid balance · no reset window" : resetAt ? resetAt.toLocaleString() : "Reset time unknown")
          .child(balance ? "prepaid balance" : resetText)));
  }
}
