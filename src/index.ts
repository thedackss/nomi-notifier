/**
 * nomi-notifier: a read-only bridge from Nomi's realtime channel to a webhook.
 *
 * Nomi's web app receives messages over a Socket.IO connection (path /socket/
 * on beta.nomi.ai, authenticated by the session cookie). This process holds
 * that same connection open and, for every message a Nomi sends (proactive
 * ones included), POSTs a small JSON payload to NOMI_WEBHOOK_URL. With no
 * webhook configured it runs in console mode and prints each message instead.
 *
 * It only observes. It never sends a message and never spends credits.
 */
import { io } from "socket.io-client";

// ---- Config (from the environment; see .env.example) ---------------------

interface Config {
    sessionToken: string;
    /** Where to POST each message. null = console mode (print to stdout). */
    webhookUrl: string | null;
    /** Only forward messages from these Nomi ids (empty = all). */
    nomiIds: number[];
    /** Only forward proactive/scheduled messages, not replies. */
    proactiveOnly: boolean;
    /** How long to wait for a message's finalized text before forwarding. */
    debounceMs: number;
}

function loadConfig(): Config {
    const sessionToken = process.env.NOMI_SESSION_TOKEN?.trim();
    if (!sessionToken) {
        console.error(
            "nomi-notifier: NOMI_SESSION_TOKEN is required (see .env.example).",
        );
        process.exit(1);
    }
    return {
        sessionToken,
        webhookUrl: process.env.NOMI_WEBHOOK_URL?.trim() || null,
        nomiIds: (process.env.NOMI_NOMI_IDS ?? "")
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean)
            .map(Number),
        proactiveOnly: process.env.NOMI_PROACTIVE_ONLY === "1",
        debounceMs: Number(process.env.NOMI_DEBOUNCE_MS ?? 1500),
    };
}

// ---- Nomi realtime protocol (as observed on the wire) --------------------

/** A chat message as carried inside a NomiChatEvent. */
interface NomiMessage {
    uuid: string;
    sent: string;
    /** Who wrote it. */
    type: "User" | "Nomi";
    text: string;
    /** True when the Nomi started the exchange itself (proactive/scheduled). */
    nomiInitiated: boolean;
    isVoiceMessage: boolean;
    unread: boolean;
}

/**
 * The `NomiChatEvent` socket event. `payload` depends on `type`:
 * a NomiMessage for the message events, a status object for `nomi_status`.
 */
interface NomiChatEvent {
    type: "nomiChatMessage" | "nomiChatMessageUpdated" | "nomi_status" | string;
    payload: unknown;
    nomiId: number;
}

/**
 * A message arrives as a streaming partial (`nomiChatMessage`) followed by
 * its finalized form (`nomiChatMessageUpdated`). We listen to both and
 * debounce per uuid so the webhook fires once, with the final text.
 */
const MESSAGE_EVENTS = new Set(["nomiChatMessage", "nomiChatMessageUpdated"]);

/** What gets POSTed to the webhook (or printed in console mode). */
export interface WebhookPayload {
    nomiId: number;
    nomiName: string | null;
    uuid: string;
    text: string;
    /** True for a message the Nomi initiated (proactive/scheduled). */
    proactive: boolean;
    isVoiceMessage: boolean;
    sent: string;
}

// ---- Service ---------------------------------------------------------------

const BASE = "https://beta.nomi.ai";
const config = loadConfig();
const cookie = `__Secure-next-auth.session-token=${config.sessionToken}`;

/** Diagnostics go to stderr; in console mode the messages themselves go to stdout. */
function log(...args: unknown[]): void {
    console.error(new Date().toISOString(), ...args);
}

/** Best-effort id -> name map, so the payload carries the Nomi's name. */
async function loadNomiNames(): Promise<Map<number, string>> {
    const names = new Map<number, string>();
    try {
        const res = await fetch(`${BASE}/api/nomis`, {
            headers: { Cookie: cookie },
        });
        const data: unknown = await res.json();
        const list = Array.isArray(data)
            ? data
            : ((data as { nomis?: unknown[] }).nomis ?? []);
        for (const n of list as { id: number; name: string }[]) {
            names.set(n.id, n.name);
        }
    } catch (e) {
        log("could not load nomi names:", (e as Error).message);
    }
    return names;
}

async function forward(payload: WebhookPayload): Promise<void> {
    const who = payload.nomiName ?? String(payload.nomiId);
    const kind = payload.proactive ? "proactive" : "reply";

    if (!config.webhookUrl) {
        // Console mode: no destination configured, print the message.
        console.log(`[${who}] (${kind}) ${payload.text}`);
        return;
    }
    try {
        const res = await fetch(config.webhookUrl, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(payload),
        });
        log(`forwarded ${payload.uuid} from ${who} (${kind}) -> HTTP ${res.status}`);
    } catch (e) {
        log("webhook POST failed:", (e as Error).message);
    }
}

/** Messages waiting on their finalized text, keyed by uuid. */
const pending = new Map<
    string,
    { payload: WebhookPayload; timer: NodeJS.Timeout }
>();

function onNomiMessage(
    msg: NomiMessage,
    nomiId: number,
    names: Map<number, string>,
): void {
    if (msg.type !== "Nomi") return; // only messages the Nomi sent
    if (config.nomiIds.length && !config.nomiIds.includes(nomiId)) return;
    const proactive = msg.nomiInitiated === true;
    if (config.proactiveOnly && !proactive) return;

    const payload: WebhookPayload = {
        nomiId,
        nomiName: names.get(nomiId) ?? null,
        uuid: msg.uuid,
        text: (msg.text ?? "").trim(),
        proactive,
        isVoiceMessage: Boolean(msg.isVoiceMessage),
        sent: msg.sent,
    };

    const existing = pending.get(msg.uuid);
    if (existing) {
        existing.payload = payload; // the newer (finalized) text wins
        return;
    }
    const timer = setTimeout(() => {
        const entry = pending.get(msg.uuid);
        pending.delete(msg.uuid);
        if (entry) void forward(entry.payload);
    }, config.debounceMs);
    pending.set(msg.uuid, { payload, timer });
}

async function main(): Promise<void> {
    const names = await loadNomiNames();
    log(`loaded ${names.size} nomi name(s)`);

    const socket = io(BASE, {
        path: "/socket/",
        transports: ["websocket"],
        extraHeaders: { Cookie: cookie },
        // socket.io-client reconnects on its own; these keep it patient.
        reconnectionDelay: 2000,
        reconnectionDelayMax: 30000,
    });
    socket.on("connect", () => log("connected", socket.id));
    socket.on("disconnect", (reason) => log("disconnected:", reason));
    socket.on("connect_error", (e) => log("connect_error:", e.message));
    socket.on("NomiChatEvent", (ev: NomiChatEvent) => {
        if (!MESSAGE_EVENTS.has(ev.type)) return;
        onNomiMessage(ev.payload as NomiMessage, ev.nomiId, names);
    });

    for (const sig of ["SIGINT", "SIGTERM"] as const) {
        process.on(sig, () => {
            log(`${sig}, shutting down`);
            socket.close();
            process.exit(0);
        });
    }

    const filters =
        (config.proactiveOnly ? " (proactive only)" : "") +
        (config.nomiIds.length ? ` for nomi(s) ${config.nomiIds.join(",")}` : "");
    log(
        config.webhookUrl
            ? `nomi-notifier started -> ${config.webhookUrl}${filters}`
            : `nomi-notifier started in console mode (no NOMI_WEBHOOK_URL): messages print below${filters}`,
    );
}

main().catch((err) => {
    console.error("nomi-notifier failed to start:", err);
    process.exit(1);
});
