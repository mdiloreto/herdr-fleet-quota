// Read each host's Omarchy quota over its existing Herdr connection.
import { View, div, svg } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { checking, closeOverlay, exec, hc, props, openOverlay, theme } from "herdr";
import { collectFleet } from "./fleet.js";
import { availabilityOf, decisiveUsage, READ_SCRIPT } from "./model.js";

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

function accountIdentity(host, row) {
  return `${host.label || host.name || "This computer"}${row.accountLabel
    ? ` · ${row.accountLabel} (${row.accountActive ? "active on host" : "not active on host"})` : ""}`;
}

// One percentage convention everywhere: percent of the quota used, on a 0-100 scale.
// A window that still has capacity must never read as fully used, so a rounded 100
// falls back to the exact value, and a rounding-to-0 keeps reading as "<1".
function usedText(used) {
  if (!Number.isFinite(used)) return null;
  const rounded = Math.round(used);
  if (rounded === 0 && used > 0) return "<1% used";
  if (rounded === 100 && used < 100) return `${Math.min(99.99, Math.round(used * 100) / 100)}% used`;
  return `${rounded}% used`;
}

// Credits keep their remaining amount; only percentages change scale.
function creditText(remaining) {
  if (!Number.isFinite(remaining)) return null;
  return remaining === 0 ? "0" : remaining < 0.01 ? "<0.01" : remaining.toFixed(2);
}

function creditLabel(remaining, currency) {
  const amount = creditText(remaining);
  return amount === null ? null : `${amount}${currency ? ` ${currency}` : ""}`;
}

function providerEvidence(group) {
  const credits = creditLabel(group.remaining, group.currency);
  const numbers = [usedText(group.used), credits && `${credits} remaining`].filter(Boolean).join(" · ")
    || "no percentage";
  return `${providerName(group.id)}: ${numbers} · ${group.readings.map(({ host, row }) => {
    const date = parseTime(row.updatedAt);
    return `${accountIdentity(host, row)} · record ${date ? date.toLocaleString() : "time unknown"}`;
  }).join("; ")}`;
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
    cx.timer.every(REFRESH_MS, (cx) => {
      cx.notify(); // Expire visible evidence even while a previous read is pending.
      this.refresh(cx);
    });
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

  // Each group carries the numbers the badge and the chips read: the highest exact
  // used percent across its readings (the window that runs out first) and the credit
  // balance of that reading, or else the first reading in the group that has one.
  availableProviders(now) {
    const groups = new Map();
    for (const host of this.hosts) {
      for (const row of host.rows ?? []) {
        const availability = availabilityOf(row, { hostStatus: this.failure ? "error" : host.status, now });
        if (availability.state !== "available") continue;
        if (!groups.has(row.id)) groups.set(row.id, { id: row.id, readings: [] });
        groups.get(row.id).readings.push({ host, row });
      }
    }
    for (const group of groups.values()) {
      const usages = group.readings.map(({ row }) => decisiveUsage(row));
      let decisive = null;
      for (const usage of usages) {
        if (Number.isFinite(usage.used) && (!decisive || usage.used > decisive.used)) decisive = usage;
      }
      const balance = decisive && Number.isFinite(decisive.remaining) ? decisive
        : usages.find((usage) => Number.isFinite(usage.remaining)) ?? null;
      group.used = decisive ? decisive.used : null;
      group.label = decisive ? decisive.label : "";
      group.remaining = balance ? balance.remaining : null;
      group.currency = balance ? balance.currency : "";
    }
    return [...groups.values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  unverifiedLabel() {
    return !this.refreshedAt && !this.failure && !this.discoveryError ? "Checking…" : "Unverified";
  }

  // Provider identity only; independent host/account evidence stays in the tooltip.
  // One number: the tightest available provider, or its credits when no available
  // provider reports a window percentage. The other providers only add a count.
  bar(t) {
    const groups = this.availableProviders(Date.now());
    let decisive = null;
    for (const group of groups) {
      if (Number.isFinite(group.used) && (!decisive || group.used > decisive.used)) decisive = group;
    }
    const funded = groups.find((group) => Number.isFinite(group.remaining)) ?? null;
    const lead = decisive ?? funded;
    const others = groups.filter((group) => group !== lead);
    const headline = decisive
      ? `Quota used: ${usedText(decisive.used).replace(/ used$/, "")} of ${providerName(decisive.id)}${decisive.label ? ` · ${decisive.label}` : ""}.`
      : funded ? `Credits remaining: ${creditLabel(funded.remaining, funded.currency)} on ${providerName(funded.id)}.` : null;
    const label = lead
      ? `${headline} ${groups.map(providerEvidence).join("\n")}`
      : `${this.unverifiedLabel()}. No provider has confirmed remaining quota in fresh readings.`;
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
      .when(Boolean(lead), (el) => el
        .child(tile(t, providerIcon(lead.id), providerColor(t, lead.id), 24)
          .id(`fleet-bar-provider-${lead.id}`).tooltip(providerEvidence(lead)).accessibility_label(providerEvidence(lead)))
        .when(Boolean(decisive), (inner) => inner.child(div().id("fleet-bar-used").flex_none()
          .text_size(11).font_semibold().text_color(providerColor(t, decisive.id))
          .child(usedText(decisive.used).replace(/ used$/, ""))))
        .when(Boolean(funded) && !decisive, (inner) => inner.child(div().id("fleet-bar-credits").flex_none()
          .text_size(11).font_semibold().text_color(providerColor(t, funded.id))
          .child(creditLabel(funded.remaining, funded.currency)))))
      .when(others.length > 0, (el) => el.child(div().id("fleet-bar-more").w(26).flex_none().text_size(10)
        .text_color(t.muted).tooltip(others.map(providerEvidence).join("\n"))
        .accessibility_label(others.map(providerEvidence).join("\n"))
        .child(others.length > 99 ? "+99+" : `+${others.length}`)))
      .when(!groups.length, (el) => el.child(div().min_w(0).truncate().text_size(11)
        .text_color(t.muted).child(this.unverifiedLabel())))
      .child(div().flex_1())
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
    const groups = this.availableProviders(now);
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
              .child(div().text_size(20).font_semibold().child("Reported quota"))
              .child(div().text_size(11).text_color(t.muted)
                .child(this.loading ? "Reading saved quota records…" : "Independent readings · per machine, per account")),
          )
          .child(
            h_flex().gap(2).items_center().flex_none()
              .child(this.iconButton(t, "fleet-refresh", ICON.refresh, "Reread saved quota records",
                (_event, cx) => this.refresh(cx), this.loading))
              .child(this.iconButton(t, "fleet-close", ICON.close, "Close fleet quota",
                () => closeOverlay(props().overlay), false)),
          ),
      )
      .child(this.overview(t, groups))
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
          .when(!this.hosts.length, (el) => el.child(this.empty(t)))
          .children(this.hosts.map((host, index) => this.host(t, host, index, now))),
      )
      .child(
        div().flex_none().border_t(1).border_color(t.border).pt(8)
          .text_size(11)
          .text_color(t.muted)
          .child(
            "Saved quotas, not a routing guarantee. Machines may share accounts; readings are never added. Refresh rereads records, not providers.",
          ),
      );
  }

  overview(t, groups) {
    return h_flex().id("fleet-overview").flex_none().min_w(0).gap(6).flex_wrap()
      .when(!groups.length, (el) => el.child(pill(t, this.unverifiedLabel(), t.muted)))
      .children(groups.slice(0, 6).map((group) => {
        const used = usedText(group.used);
        const name = used ? `${providerName(group.id)} ${used.replace(/ used$/, "")}` : providerName(group.id);
        return h_flex().id(`fleet-available-${group.id}`)
          .min_w(0).max_w(180).gap(6).px(8).py(5).items_center().rounded(7).bg(t.surface)
          .border(1).border_color(providerColor(t, group.id))
          .tooltip(providerEvidence(group)).accessibility_label(providerEvidence(group))
          .child(icon(providerIcon(group.id), 14, providerColor(t, group.id)))
          .child(div().min_w(0).truncate().text_size(12).text_color(providerColor(t, group.id)).child(name));
      }))
      .when(groups.length > 6, (el) => el.child(pill(t, `+${groups.length - 6} more`, t.muted)
        .tooltip(groups.slice(6).map(providerEvidence).join("\n"))
        .accessibility_label(groups.slice(6).map(providerEvidence).join("\n"))));
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
      .children(rows.map((row, index) => this.provider(t, row, hostIndex, index, now, this.failure ? "error" : host.status)));
  }

  // One provider or account on one machine, under its own windows.
  provider(t, row, hostIndex, rowIndex, now, hostStatus) {
    const windows = Array.isArray(row?.windows) ? row.windows : [];
    const updated = stamp(t, row?.updatedAt, "record", now);
    const color = providerColor(t, row?.id);
    const stale = hostStatus !== "ok" || Boolean(row?.stale) || (Number.isFinite(row?.freshUntil) && now > row.freshUntil);
    const availability = availabilityOf(row, { hostStatus, now });
    const freshness = !Number.isFinite(row?.freshUntil) ? "time unknown" : stale ? "old" : "current";
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
          .child(pill(t, freshness, freshness === "current" ? t.done : t.working)),
      )
      .child(div().id(`fleet-availability-${hostIndex}-${rowIndex}`).text_size(11)
        .text_color(availability.state === "available" ? t.done : availability.state === "exhausted" ? t.working : t.muted)
        .child(availability.reason))
      .when(Boolean(row?.accountLabel || row?.incomplete), (el) => el.child(h_flex().gap(6).items_center().flex_wrap().min_w(0)
        .when(Boolean(row?.accountLabel), (el) => el.child(pill(t, row.accountActive ? "active on host" : "not active on host", color)))
        .when(Boolean(row?.incomplete), (el) => el.child(pill(t, "incomplete", t.working)))))
      .when(!windows.length, (el) => el.child(div().text_size(11).text_color(t.dim).child("No quota reported.")))
      .children(windows.map((w, index) => this.window(t, w, row, hostIndex, rowIndex, index, now, stale)));
  }

  window(t, w, row, hostIndex, rowIndex, windowIndex, now, stale = Boolean(row?.stale)) {
    const balance = Boolean(w?.isBalance);
    const reset = balance ? null : resetLabel(w?.resetsAt, now);
    const resetAt = parseTime(w?.resetsAt);
    const raw = balance ? w?.remaining : reset === "passed" ? null : w?.remainingPercent;
    const remaining = Number.isFinite(raw) && raw >= 0 ? raw : null;
    // The same exact used percent the badge reads: the meter and the number agree.
    const used = balance || remaining === null ? null : 100 - remaining;
    const usedLabel = usedText(used);
    const label = balance ? "Prepaid balance" : w?.label ?? "—";
    const currency = w?.currency ? ` ${w.currency}` : "";
    const amount = balance && remaining !== null ? creditText(remaining) : null;
    const value = balance ? (amount === null ? null : `${amount}${currency} remaining`) : usedLabel;
    // Balances keep their raw amount in the tooltip; percentages keep the used scale.
    const verbatim = balance ? (remaining === null ? null : `${remaining}${currency} remaining`) : usedLabel;
    const estimated = w?.estimated ? " (estimated)" : "";
    const reading = `${value ?? "Remaining unknown"}${estimated}`;
    // A stale window keeps its last saved value as history, never as a reading.
    const savedValue = verbatim === null ? "Remaining unknown, not zero" : `${verbatim}${estimated}`;
    const exact = stale ? `last saved: ${savedValue}` : savedValue;
    const unknown = value === null;
    const color = (balance ? remaining === 0 : used === 100) ? t.working : providerColor(t, row?.id);
    const reason = reset === "passed" ? "Awaiting reading after reset" : w?.reason;
    const resetText = reset === "passed" ? "reset passed" : `resets ${reset}`;
    const savedAt = stale ? stamp(t, row?.updatedAt, "saved", now) : null;
    return v_flex()
      .id(`fleet-window-${hostIndex}-${rowIndex}-${windowIndex}`)
      .gap(3).min_w(0)
      .child(h_flex().gap(8).items_center().min_w(0)
        .child(div().flex_1().min_w(0).truncate().text_size(12).tooltip(label).accessibility_label(label).child(label))
        .child(div().id(`fleet-window-pct-${hostIndex}-${rowIndex}-${windowIndex}`)
          .w(190).flex_none().truncate().tooltip(exact).accessibility_label(exact).text_right().text_size(12).font_semibold()
          .text_color(stale || unknown ? t.muted : color).child(stale ? "No live reading" : reading)))
      .child(h_flex().gap(10).items_center().min_w(0).when(!balance, (el) => el.child(
        h_flex()
          .id(`fleet-window-track-${hostIndex}-${rowIndex}-${windowIndex}`)
          .flex_1().min_w(0)
          .h(6)
          .rounded(3)
          .items_center()
          .overflow_hidden()
          .bg(t.border)
          .role("progress_indicator")
          .accessibility_label(stale ? `${label}: no live reading; ${exact}`
            : usedLabel === null ? `${label}: remaining unknown`
            : `${label}: ${usedLabel.replace(/ used$/, "")} of the quota used`)
          .when(used !== null && !stale, (el) =>
            el.child(div()
              .id(`fleet-window-fill-${hostIndex}-${rowIndex}-${windowIndex}`)
              .h_full()
              .flex_none()
              .w(`${Math.min(100, used)}%`)
              .rounded(3)
              .bg(color))),
      ))
        .child(div().w(142).flex_none().text_right().text_size(10).text_color(t.muted)
          .tooltip(stale ? "Last saved reading · the reset time is from the record, not a live read"
            : balance ? "Prepaid balance · no reset window" : resetAt ? resetAt.toLocaleString() : "Reset time unknown")
          .when(stale, (el) => el.child(savedAt ?? div().text_size(10).child("saved time unknown")))
          .when(!stale, (el) => el.child(balance ? "prepaid balance" : resetText))))
      .when(Boolean(reason), (el) => el.child(div().text_size(11).text_color(t.muted).child(reason)));
  }
}
