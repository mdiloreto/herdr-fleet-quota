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
  claude: { name: "Claude", icon: "icons/claude.svg" },
  codex: { name: "Codex", icon: "icons/codex.svg" },
  copilot: { name: "GitHub Copilot", icon: "icons/copilot.svg" },
  agy: { name: "Antigravity", icon: "icons/antigravity.svg" },
  gemini: { name: "Gemini", icon: "icons/gemini.svg" },
  openrouter: { name: "OpenRouter", icon: ICON.provider },
  fireworks: { name: "Fireworks", icon: ICON.provider },
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

// "just now", "5m ago", "3h ago": short enough for a dense card, and the exact
// timestamp stays in the tooltip. A time in the future is no evidence of a
// read, so it says nothing.
function relativeTime(date, now) {
  if (!date) return null;
  const diff = now - date.getTime();
  if (!Number.isFinite(diff) || diff < 0) return null;
  if (diff < 45000) return "just now";
  const minutes = Math.floor(diff / 60000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return date.toLocaleDateString([], { month: "short", day: "numeric" });
}

// When a window resets: the clock time, for a time today or later, and a date
// when it's further out. Missing or unreadable resets show "?" like a reading.
function resetLabel(resetsAt, now = Date.now()) {
  const when = parseTime(resetsAt);
  if (!when) return "?";
  if (when.getTime() <= now) return "passed";
  const today = new Date(now);
  const sameDay = when.toDateString() === today.toDateString();
  const time = when.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return sameDay ? time : when.toLocaleDateString([], { weekday: "short" }) + " " + time;
}

// A short relative hint that keeps the exact time on hover. A missing or
// unreadable time draws nothing rather than a made-up one.
function stamp(t, value, prefix, now) {
  const date = parseTime(value);
  const relative = relativeTime(date, now);
  if (!relative) return null;
  return div()
    .text_size(11)
    .text_color(t.dim)
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
    .h(16)
    .px(6)
    .rounded(8)
    .bg(t.surface)
    .border(1)
    .border_color(t.border)
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
  if (status === "ok") return t.muted;
  if (status === "error") return t.blocked;
  return t.dim;
}

function providerOf(id) {
  return PROVIDERS[id] ?? null;
}

function providerName(id) {
  return providerOf(id)?.name ?? (id || "unknown");
}

function providerIcon(id) {
  return providerOf(id)?.icon ?? ICON.provider;
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

  // The bar shows the highest reported percentage and indicates incomplete coverage.
  // Always clickable, so the dialog opens even before the first read lands.
  bar(t) {
    const known = this.hosts.length;
    const read = this.hosts.filter((h) => h.status === "ok").length;
    const readings = this.hosts.flatMap((host) => (host.rows ?? [])
      .filter((row) => percentOf(row.used) !== null)
      .map((row) => ({ host, row })));
    const highest = readings.reduce((best, item) => !best || item.row.used > best.row.used ? item : best, null);
    const old = highest && (highest.row.stale || highest.host.status !== "ok");
    const incomplete = !!this.discoveryError || !!this.failure || this.hosts.some((host) =>
      host.status !== "ok" || host.errors > 0 || (host.rows ?? []).some((row) => row.used === null));
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
      .px(10)
      .gap(6)
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
      .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.muted).child(`AI ${value}`))
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
    const known = this.hosts.length;
    const read = this.hosts.filter((h) => h.status === "ok").length;
    const count = known
      ? `${read} of ${known} ${known === 1 ? "machine" : "machines"} with a reading`
      : "No machines read yet";
    const updatedAt = parseTime(this.refreshedAt);
    const updated = relativeTime(updatedAt, now);
    return v_flex()
      .id("fleet-quota-panel")
      .size_full()
      .bg(t.surface)
      .p(14)
      .gap(10)
      .text_size(13)
      .child(
        h_flex()
          .id("fleet-heading")
          .items_center()
          .justify_between()
          .gap(10)
          .child(
            h_flex()
              .gap(8)
              .items_center()
              .min_w(0)
              .flex_1()
              .child(icon(ICON.gauge, 16, t.muted))
              .child(
                v_flex()
                  .gap(1)
                  .min_w(0)
                  .child(div().font_semibold().child("Fleet quota"))
                  .child(
                    h_flex()
                      .gap(4)
                      .items_center()
                      .min_w(0)
                      .child(div().text_size(11).text_color(t.dim).truncate()
                        .child(this.loading && known ? "Reading…" : count))
                      .when(Boolean(updated), (el) =>
                        el.child(icon(ICON.clock, 10, t.dim))
                          .child(div().text_size(11).text_color(t.dim).tooltip(updatedAt.toLocaleString())
                            .child(updated))),
                  ),
              ),
          )
          .child(
            h_flex().gap(2).items_center().flex_none()
              .child(this.iconButton(t, "fleet-refresh", ICON.refresh, "Reread saved quota records",
                (_event, cx) => this.refresh(cx), this.loading))
              .child(this.iconButton(t, "fleet-close", ICON.close, "Close fleet quota",
                () => closeOverlay(props().overlay), false)),
          ),
      )
      .when(Boolean(this.failure || this.discoveryError), (el) =>
        el.child(this.notice(t)),
      )
      .child(
        v_flex()
          .id("fleet-hosts")
          .flex_1()
          .min_h(0)
          .gap(8)
          .overflow_y_scrollbar()
          .when(!known, (el) => el.child(this.empty(t)))
          .children(this.hosts.map((host, index) => this.host(t, host, index, now))),
      )
      .child(
        div()
          .text_size(11)
          .text_color(t.dim)
          .child(
            "Each card is one machine's own reading. Two machines signed in to the same provider can share one account, so nothing here is added up.",
          ),
      );
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
      .w(22)
      .h(22)
      .rounded(6)
      .cursor_pointer()
      .hover((s) => s.bg(t.hover))
      .on_click(onClick)
      .child(icon(path, 13, busy ? t.dim : t.muted));
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
    // A reading kept from before the machine stopped answering is said so.
    const earlier = host?.status !== "ok" && rows.length > 0;
    const read = rows.length ? stamp(t, host?.lastSuccessAt, "read", now) : null;
    return v_flex()
      .id(`fleet-host-${hostIndex}`)
      .gap(8)
      .p(10)
      .rounded(8)
      .bg(t.raised)
      .border(1)
      .border_color(t.border)
      .child(
        h_flex()
          .gap(8)
          .items_center()
          .min_w(0)
          .child(icon(host?.name == null ? ICON.desktop : ICON.server, 14, t.muted))
          .child(div().font_semibold().truncate().flex_shrink(1).min_w(0)
            .child(host?.label || host?.name || "This computer"))
          .child(pill(t, status.word, statusColor(t, host?.status)))
          .when(Number(host?.errors) > 0, (el) =>
            el.child(pill(t, `${host.errors} unreadable or omitted`, t.dim)))
          .when(earlier, (el) => el.child(pill(t, "old reading", t.dim)))
          .child(div().flex_1())
          .when(Boolean(read), (el) => el.child(read)),
      )
      .when(rows.length === 0, (el) =>
        el.child(div().text_size(12).text_color(t.dim).child(host?.reason || status.empty)))
      .when(Boolean(rows.length && host?.reason), (el) =>
        el.child(div().text_size(11).text_color(t.dim).child(host.reason)))
      .when(Number(host?.truncated) > 0, (el) =>
        el.child(div().text_size(11).text_color(t.dim).child("Some accounts omitted: limit 16 per provider.")))
      .when(Number(host?.truncatedWindows) > 0, (el) =>
        el.child(div().text_size(11).text_color(t.dim).child("Some quota windows omitted: limit 20 per account.")))
      .children(rows.map((row, index) => this.provider(t, row, hostIndex, index, now)));
  }

  // One provider or account on one machine, under its own windows.
  provider(t, row, hostIndex, rowIndex, now) {
    const windows = Array.isArray(row?.windows) ? row.windows : [];
    const updated = stamp(t, row?.updatedAt, "record", now);
    return v_flex()
      .id(`fleet-provider-${hostIndex}-${rowIndex}`)
      .gap(4)
      .pl(10)
      .child(
        h_flex()
          .gap(6)
          .items_center()
          .min_w(0)
          .child(icon(providerIcon(row?.id), 14, t.muted))
          .child(div().text_size(12).text_color(t.foreground).font_medium().truncate()
            .child(providerName(row?.id)))
          .when(Boolean(row?.accountLabel), (el) =>
            el.child(div().text_size(11).text_color(t.muted).truncate().flex_shrink(1).min_w(0)
              .child(row.accountLabel)))
          .when(Boolean(row?.accountActive), (el) => el.child(pill(t, "active", t.muted)))
          .when(Boolean(row?.stale), (el) => el.child(pill(t, "old", t.dim)))
          .when(Boolean(row?.incomplete), (el) => el.child(pill(t, "incomplete", t.dim)))
          .child(div().flex_1())
          .when(Boolean(updated), (el) => el.child(updated)),
      )
      .when(!windows.length, (el) => el.child(div().text_size(11).text_color(t.dim).child("No quota reported.")))
      .children(windows.map((w, index) => this.window(t, w, row, hostIndex, rowIndex, index, now)));
  }

  window(t, w, row, hostIndex, rowIndex, windowIndex, now) {
    const pct = percentOf(w?.used);
    const balance = Boolean(w?.isBalance);
    const stale = Boolean(row?.stale);
    const reset = balance ? null : resetLabel(w?.resetsAt, now);
    const resetAt = parseTime(w?.resetsAt);
    const label = w?.label ?? "—";
    const reading = pct === null ? (balance ? "no percentage" : "? used") : `${pct}% used`;
    const clip = `${pct === null
      ? (balance ? "no percentage available" : "percentage unavailable, not zero")
      : `${pct} percent used`}${stale ? ", from an earlier reading" : ""}`;
    return h_flex()
      .id(`fleet-window-${hostIndex}-${rowIndex}-${windowIndex}`)
      .gap(8)
      .items_center()
      .min_w(0)
      .pl(10)
      .child(div().flex_1().min_w(0).truncate().text_color(t.foreground).child(label))
      .child(
        h_flex()
          .id(`fleet-window-track-${hostIndex}-${rowIndex}-${windowIndex}`)
          .w(84)
          .h(6)
          .flex_none()
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
              .w(`${pct}%`)
              .rounded(3)
              .bg(stale ? t.dim : t.accent))),
      )
      .child(
        h_flex()
          .id(`fleet-window-pct-${hostIndex}-${rowIndex}-${windowIndex}`)
          .w(62)
          .flex_none()
          .justify_end()
          .child(div().text_size(12).text_color(pct === null ? t.dim : t.foreground).child(reading)),
      )
      .when(!balance, (el) =>
        el.child(
          h_flex()
            .w(88)
            .flex_none()
            .justify_end()
            .when(Boolean(resetAt), (inner) => inner.tooltip(resetAt.toLocaleString()))
            .child(div().text_size(11).text_color(t.dim)
              .child(reset === "passed" ? "reset passed" : `resets ${reset}`)),
        ));
  }
}
