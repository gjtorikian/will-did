/**
 * The talk's server: the vote page the room reaches over a QR code, the admin
 * page that's projected, and the stream of events between them.
 *
 *   GET  /                 the vote page
 *   POST /vote             { voter, choice }
 *   GET  /events           the tally, streamed (server-sent events)
 *   GET  /tally            the tally, once
 *   GET  /admin?key=       the admin page: QR code, votes, the live count, settle
 *   POST /heard?key=       { heard }    the admin page's running count, kept from the room until it settles
 *   POST /settle?key=      { heard? }   settle by the count; it is revealed from here on
 *   POST /reopen?key=
 *   GET  /qr.svg?key=&url=
 *
 * Every start begins with no votes and a count of zero, and phones that
 * voted in an earlier run are asked again. The run is still written to
 * data/talk.json on every change, so `--resume` can pick it up after a crash.
 *
 *   npm run talk                                   # http://localhost:8080
 *   npm run talk -- --tunnel                       # and a public address, via a Cloudflare quick tunnel
 *   PORT=9000 PUBLIC_URL=https://… npm run talk    # a public address from some other tunnel
 *   npm run talk -- --resume                       # carry on from the last run
 */
import { spawn } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { networkInterfaces } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import Handlebars from "handlebars";
import QRCode from "qrcode";
import { readJSON, writeJSON } from "../capture/store.js";
import { loadMeta, markDid } from "../publish/templates.js";
import { empty, heard, reopen, settle, tally, vote, type TalkConfig, type TalkState, type Tally } from "./market.js";

export interface TalkOptions {
  port: number;
  host: string;
  /** where talk.json, site.json and talk/ live (default "site") */
  siteDir: string;
  /** where the run is written, for --resume (default "data") */
  dataDir: string;
  /** what the admin page and its calls carry in `?key=` */
  adminKey: string;
  /** the address the QR code should point at, if known */
  publicUrl?: string;
  /** open a Cloudflare quick tunnel to this server and use its address */
  tunnel?: boolean;
  /** the published site, for the vote page's title link */
  siteUrl?: string;
  /** carry on from the run saved in dataDir instead of starting empty */
  resume?: boolean;
}

class HttpError extends Error {
  constructor(
    public status: number,
    message = "",
  ) {
    super(message);
  }
}

/** A small JSON body, or 400/413. */
async function body(req: IncomingMessage, limit = 4096): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req as AsyncIterable<Buffer>) {
    size += c.length;
    if (size > limit) throw new HttpError(413, "too large");
    chunks.push(c);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "bad json");
  }
}

const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/** The inline initial state: `<` escaped so it can't close the script tag. */
const inline = (v: unknown) => JSON.stringify(v).replaceAll("<", "\\u003c");

const lanAddresses = () =>
  Object.values(networkInterfaces())
    .flat()
    .filter((i) => i && i.family === "IPv4" && !i.internal)
    .map((i) => i!.address);

/** A Cloudflare quick tunnel to this server: no account, just `brew install
 *  cloudflared`. It logs the address it was given a few seconds in; `found`
 *  gets it once. */
function tunnel(port: number, found: (url: string) => void) {
  const child = spawn("cloudflared", ["tunnel", "--url", `http://localhost:${port}`], { stdio: ["ignore", "pipe", "pipe"] });
  let url: string | undefined;
  const watch = (stream: NodeJS.ReadableStream) =>
    createInterface({ input: stream }).on("line", (line) => {
      const m = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/.exec(line);
      if (m && !url) found((url = m[0]));
    });
  watch(child.stdout!);
  watch(child.stderr!);
  child.on("error", (err: NodeJS.ErrnoException) => {
    console.error(err.code === "ENOENT" ? "tunnel  cloudflared not found: brew install cloudflared, or start with PUBLIC_URL set" : err);
  });
  child.on("exit", (code) => {
    if (code) console.error(`tunnel  cloudflared exited with ${code}`);
  });
  return { close: () => child.kill() };
}

export async function serve(opts: TalkOptions) {
  const { siteDir, dataDir } = opts;
  let publicUrl = opts.publicUrl;
  const cfg = JSON.parse(await readFile(join(siteDir, "talk.json"), "utf8")) as TalkConfig;
  const meta = await loadMeta(siteDir);

  const file = join(dataDir, "talk.json");
  const state: TalkState = (opts.resume ? await readJSON<TalkState>(file) : null) ?? empty();
  state.run ||= empty().run; // a run saved before runs had ids
  let saving = Promise.resolve();
  const save = () => (saving = saving.then(() => writeJSON(file, state)).catch((err) => console.error("could not save", err)));
  await save();

  const hb = Handlebars.create();
  hb.registerHelper("did", (line: string) => new hb.SafeString(markDid(line, '<span class="did">', "</span>")));
  hb.registerHelper("eq", (a: unknown, b: unknown) => a === b);
  const page = async (name: string) => hb.compile(await readFile(join(siteDir, "talk", `${name}.hbs`), "utf8"));
  const t = { vote: await page("vote"), admin: await page("admin") };
  const css: Record<string, Buffer> = {
    "/style.css": await readFile(join(siteDir, "style.css")),
    "/talk.css": await readFile(join(siteDir, "talk", "talk.css")),
  };

  /* ---------- the stream ---------- */

  const clients = new Set<ServerResponse>();
  const current = () => tally(state, cfg);
  const push = (res: ServerResponse, t: Tally) => res.write(`data: ${JSON.stringify(t)}\n\n`);
  /** Persist a change and tell every open page. */
  const changed = () => {
    save();
    const now = current();
    for (const c of clients) push(c, now);
    return now;
  };
  const ping = setInterval(() => {
    for (const c of clients) c.write(": ping\n\n");
  }, 25_000);
  ping.unref();

  /* ---------- the routes ---------- */

  const send = (res: ServerResponse, status: number, type: string, out: string | Buffer) => {
    res.writeHead(status, { "content-type": type, "cache-control": "no-store" });
    res.end(out);
  };
  const html = (res: ServerResponse, out: string) => send(res, 200, "text/html; charset=utf-8", out);
  const api = (res: ServerResponse, status: number, out: unknown) => send(res, status, "application/json", JSON.stringify(out));

  async function handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? "/", "http://localhost");
    const admin = same(url.searchParams.get("key") ?? "", opts.adminKey);
    switch (`${req.method} ${url.pathname}`) {
      case "GET /": {
        const now = current();
        return html(res, t.vote({ meta, site: opts.siteUrl, tally: now, initial: inline(now) }));
      }
      case "GET /style.css":
      case "GET /talk.css":
        return send(res, 200, "text/css; charset=utf-8", css[url.pathname]);
      case "GET /tally":
        return api(res, 200, current());
      case "GET /events": {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive", "x-accel-buffering": "no" });
        res.write("retry: 2000\n\n");
        push(res, current());
        clients.add(res);
        req.on("close", () => clients.delete(res));
        return;
      }
      case "POST /vote": {
        const b = (await body(req)) as { voter?: unknown; choice?: unknown } | null;
        const outcome = vote(state, b?.voter, b?.choice);
        if (outcome === "bad") throw new HttpError(400, "bad vote");
        if (outcome !== "ok") throw new HttpError(409, outcome);
        return api(res, 200, changed());
      }
      case "GET /admin": {
        if (!admin) throw new HttpError(404);
        const now = current();
        // The admin page alone is told the count before the market settles.
        return html(res, t.admin({ meta, cfg, key: opts.adminKey, publicUrl: publicUrl ?? "", tally: now, heard: state.heard, initial: inline({ ...now, heard: state.heard }) }));
      }
      case "POST /heard": {
        if (!admin) throw new HttpError(404);
        const b = (await body(req)) as { heard?: unknown } | null;
        if (!heard(state, b?.heard)) throw new HttpError(400, "bad count");
        return api(res, 200, changed());
      }
      case "POST /settle": {
        if (!admin) throw new HttpError(404);
        const b = (await body(req)) as { heard?: unknown } | null;
        if (b?.heard !== undefined && !heard(state, b.heard)) throw new HttpError(400, "bad count");
        settle(state, cfg);
        return api(res, 200, changed());
      }
      case "POST /reopen": {
        if (!admin) throw new HttpError(404);
        reopen(state);
        return api(res, 200, changed());
      }
      case "GET /qr.svg": {
        if (!admin) throw new HttpError(404);
        const target = url.searchParams.get("url") ?? "";
        if (!/^https?:\/\/\S{1,512}$/.test(target)) throw new HttpError(400, "bad url");
        const svg = await QRCode.toString(target, { type: "svg", margin: 0, errorCorrectionLevel: "M", color: { dark: "#000000", light: "#ffffff" } });
        return send(res, 200, "image/svg+xml", svg);
      }
      default:
        throw new HttpError(404);
    }
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      const status = err instanceof HttpError ? err.status : 500;
      if (status === 500) console.error(err);
      if (res.headersSent) res.end();
      else api(res, status, { error: err instanceof HttpError ? err.message || String(status) : "server error" });
    });
  });
  await new Promise<void>((resolve) => server.listen(opts.port, opts.host, resolve));

  // The tunnel's address arrives after the pages may have loaded; an open
  // admin page is told so its QR code redraws.
  const quick = opts.tunnel
    ? tunnel(opts.port, (url) => {
        publicUrl = url;
        console.log(`tunnel  ${url}`);
        for (const c of clients) c.write(`event: tunnel\ndata: ${JSON.stringify({ url })}\n\n`);
      })
    : null;

  return {
    server,
    cfg,
    state,
    lan: lanAddresses(),
    close: async () => {
      quick?.close();
      clearInterval(ping);
      for (const c of clients) c.end();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await saving;
    },
  };
}

const isMain = process.argv[1]?.endsWith("server.js");
if (isMain) {
  const port = Number(process.env.PORT ?? 8080);
  const adminKey = process.env.ADMIN_KEY ?? randomBytes(4).toString("hex");
  serve({
    port,
    host: process.env.HOST ?? "0.0.0.0",
    siteDir: process.env.SITE_DIR ?? "site",
    dataDir: process.env.DATA_DIR ?? "data",
    adminKey,
    publicUrl: process.env.PUBLIC_URL,
    siteUrl: process.env.SITE_URL,
    tunnel: process.argv.includes("--tunnel"),
    resume: process.argv.includes("--resume"),
  })
    .then((s) => {
      const now = tally(s.state, s.cfg);
      console.log(now.question);
      console.log(`${now.yes} yes · ${now.no} no · heard ${now.heard}${now.resolved ? ` · settled ${now.resolved}` : ""}`);
      console.log(`vote    http://localhost:${port}/${s.lan.map((a) => `   http://${a}:${port}/`).join("")}`);
      console.log(`admin   http://localhost:${port}/admin?key=${adminKey}`);
      const stop = () => s.close().finally(() => process.exit(0));
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
