/**
 * A small SMTP client for wake emails, so the API needs no mail library (the
 * root package is also the `letagents` npm package agents install).
 *
 * `smtps://` connects with TLS at once; `smtp://` must upgrade with STARTTLS
 * before anything else is sent, and is refused when the server does not offer
 * it. Certificates are verified. AUTH PLAIN or LOGIN, one recipient, a
 * plain-text UTF-8 body in quoted-printable, dot-stuffing, and a timeout on
 * every step. The host is resolved with c-ares within a deadline. Errors name
 * only the step and the reply code, never server text or the URL.
 */
import { randomUUID } from "node:crypto";
import net, { isIP } from "node:net";
import tls from "node:tls";

import { resolveWithinDeadline, type HostResolver } from "./dns-resolve.js";

export type SmtpStage = "config" | "connect" | "greeting" | "ehlo" | "starttls" | "auth" | "mail" | "rcpt" | "data";

export class SmtpError extends Error {
  constructor(readonly stage: SmtpStage, readonly code: number) {
    super(`SMTP ${stage} failed${code ? ` (${code})` : ""}`);
    this.name = "SmtpError";
  }
}

export interface SmtpConfig {
  secure: boolean;
  host: string;
  port: number;
  username: string | null;
  password: string | null;
}

/** `smtps://user:pass@host:465` or `smtp://user:pass@host:587`. Throws SmtpError("config") without saying why. */
export function parseSmtpUrl(raw: string): SmtpConfig {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new SmtpError("config", 0);
  }
  const secure = url.protocol === "smtps:";
  if (!secure && url.protocol !== "smtp:") throw new SmtpError("config", 0);
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (!host) throw new SmtpError("config", 0);
  const port = url.port ? Number(url.port) : secure ? 465 : 587;
  const decode = (value: string) => (value ? decodeURIComponent(value) : null);
  return { secure, host, port, username: decode(url.username), password: decode(url.password) };
}

export interface SmtpMessage {
  /** The From header, e.g. `LetAgents <notify@letagents.chat>`. */
  from: string;
  to: string;
  subject: string;
  text: string;
  headers?: Readonly<Record<string, string>>;
}

export interface SmtpSendOptions {
  resolve?: HostResolver;
  /** Tests: trust this certificate authority. */
  ca?: string;
  timeoutMs?: number;
  /** The name given in EHLO. */
  clientName?: string;
  now?: Date;
}

const oneHeaderLine = (value: string) => value.replace(/[\r\n]+/g, " ").trim();
const isAscii = (value: string) => /^[\x20-\x7e]*$/.test(value);

/** RFC 2047 encoded words of at most 75 characters, split on character boundaries. */
function encodedWords(value: string): string {
  const words: string[] = [];
  let chunk = "";
  for (const character of Array.from(value)) {
    if (Buffer.byteLength(chunk + character, "utf8") > 45) {
      words.push(chunk);
      chunk = "";
    }
    chunk += character;
  }
  if (chunk) words.push(chunk);
  return words.map((word) => `=?UTF-8?B?${Buffer.from(word, "utf8").toString("base64")}?=`).join("\r\n ");
}

function headerText(value: string): string {
  const line = oneHeaderLine(value);
  return isAscii(line) && line.length <= 70 ? line : encodedWords(line);
}

/** The address inside a From value: `Name <a@b>` or a bare address. */
export function mailboxAddress(value: string): string {
  const match = /<([^<>\s]+@[^<>\s]+)>\s*$/.exec(value) ?? /^\s*([^<>\s]+@[^<>\s]+)\s*$/.exec(value);
  if (!match) throw new SmtpError("config", 0);
  return match[1]!;
}

function fromHeader(value: string): string {
  const address = mailboxAddress(value);
  const name = oneHeaderLine(value.replace(/<[^<>]*>\s*$/, "")).replace(/^"|"$/g, "");
  if (!name || name === address) return address;
  const display = isAscii(name) ? `"${name.replace(/["\\]/g, "")}"` : encodedWords(name);
  return `${display} <${address}>`;
}

/** Quoted-printable (RFC 2045) with CRLF line ends and soft breaks at 76 characters. */
export function quotedPrintable(text: string): string {
  return text.replace(/\r\n|\r/g, "\n").split("\n").map((line) => {
    const bytes = Buffer.from(line, "utf8");
    let out = "";
    let width = 0;
    bytes.forEach((byte, index) => {
      const plain = (byte >= 33 && byte <= 126 && byte !== 61) || ((byte === 32 || byte === 9) && index < bytes.length - 1);
      const token = plain ? String.fromCharCode(byte) : `=${byte.toString(16).toUpperCase().padStart(2, "0")}`;
      if (width + token.length > 75) {
        out += "=\r\n";
        width = 0;
      }
      out += token;
      width += token.length;
    });
    return out;
  }).join("\r\n");
}

/** A line that starts with a period gets one more (RFC 5321 4.5.2). */
export function dotStuff(data: string): string {
  return data.replace(/(^|\r\n)\./g, "$1..");
}

export function buildMimeMessage(message: SmtpMessage, now = new Date()): string {
  const domain = mailboxAddress(message.from).split("@")[1] ?? "letagents.invalid";
  const headers: Array<[string, string]> = [
    ["From", fromHeader(message.from)],
    ["To", mailboxAddress(message.to)],
    ["Subject", headerText(message.subject)],
    ["Date", now.toUTCString().replace("GMT", "+0000")],
    ["Message-ID", `<${randomUUID()}@${domain}>`],
    ["MIME-Version", "1.0"],
    ["Content-Type", "text/plain; charset=utf-8"],
    ["Content-Transfer-Encoding", "quoted-printable"],
    ...Object.entries(message.headers ?? {}).map(([name, value]): [string, string] => [name.replace(/[^A-Za-z0-9-]/g, ""), oneHeaderLine(value)]),
  ];
  return `${headers.map(([name, value]) => `${name}: ${value}`).join("\r\n")}\r\n\r\n${quotedPrintable(message.text)}`;
}

/** Reads SMTP replies from a socket that may be swapped for its TLS upgrade. */
class Conversation {
  private buffer = "";
  private lines: string[] = [];
  private waiter: ((line: string | null) => void) | null = null;
  private failure: Error | null = null;
  private socket!: net.Socket;
  private readonly onData = (chunk: Buffer) => {
    this.buffer += chunk.toString("utf8");
    if (this.buffer.length > 65_536) return this.fail(new Error("reply too long"));
    for (let index = this.buffer.indexOf("\n"); index >= 0; index = this.buffer.indexOf("\n")) {
      const line = this.buffer.slice(0, index).replace(/\r$/, "");
      this.buffer = this.buffer.slice(index + 1);
      if (this.waiter) {
        const waiter = this.waiter;
        this.waiter = null;
        waiter(line);
      } else this.lines.push(line);
    }
  };
  private readonly onError = (error: Error) => this.fail(error);
  private readonly onClose = () => this.fail(new Error("closed"));

  constructor(socket: net.Socket, private readonly timeoutMs: number) {
    this.attach(socket);
  }

  attach(socket: net.Socket): void {
    this.socket = socket;
    // Nothing read before the TLS upgrade may be taken as a reply after it.
    this.buffer = "";
    this.lines = [];
    socket.on("data", this.onData);
    socket.on("error", this.onError);
    socket.on("close", this.onClose);
  }

  /** Whether the server sent anything not yet read: before a TLS upgrade, that is an injection. */
  hasUnread(): boolean {
    return this.lines.length > 0 || this.buffer.length > 0;
  }

  /** Stop reading the plain socket before TLS takes it over. */
  detach(): net.Socket {
    this.socket.off("data", this.onData);
    this.socket.off("error", this.onError);
    this.socket.off("close", this.onClose);
    return this.socket;
  }

  private fail(error: Error): void {
    this.failure ??= error;
    if (this.waiter) {
      const waiter = this.waiter;
      this.waiter = null;
      waiter(null);
    }
  }

  private line(): Promise<string> {
    const queued = this.lines.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    if (this.failure) return Promise.reject(this.failure);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiter = null;
        reject(new Error("timeout"));
      }, this.timeoutMs);
      this.waiter = (line) => {
        clearTimeout(timer);
        if (line === null) reject(this.failure ?? new Error("closed"));
        else resolve(line);
      };
    });
  }

  async reply(stage: SmtpStage): Promise<{ code: number; lines: string[] }> {
    const lines: string[] = [];
    for (;;) {
      let line: string;
      try {
        line = await this.line();
      } catch {
        throw new SmtpError(stage, 0);
      }
      // RFC 5321 4.2: a final line may be the bare code, with no space after it.
      const match = /^(\d{3})(?:([ -])(.*))?$/.exec(line);
      if (!match || lines.length > 100) throw new SmtpError(stage, 0);
      lines.push(match[3] ?? "");
      if (match[2] !== "-") return { code: Number(match[1]), lines };
    }
  }

  async command(stage: SmtpStage, line: string, expected: readonly number[]): Promise<string[]> {
    this.socket.write(`${line}\r\n`);
    const reply = await this.reply(stage);
    if (!expected.includes(reply.code)) throw new SmtpError(stage, reply.code);
    return reply.lines;
  }

  write(data: string): void {
    this.socket.write(data);
  }

  close(): void {
    this.socket.destroy();
  }
}

function connected(socket: net.Socket, event: "connect" | "secureConnect", timeoutMs: number, stage: SmtpStage): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new SmtpError(stage, 0));
    }, timeoutMs);
    const onReady = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new SmtpError(stage, 0));
    };
    const cleanup = () => {
      clearTimeout(timer);
      socket.off(event, onReady);
      socket.off("error", onError);
    };
    socket.once(event, onReady);
    socket.once("error", onError);
  });
}

/** Send one message to one recipient. Resolves when the server accepted it; throws SmtpError otherwise. */
export async function sendSmtpMail(config: SmtpConfig, message: SmtpMessage, options: SmtpSendOptions = {}): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 20_000;
  const envelopeFrom = mailboxAddress(message.from);
  const recipient = mailboxAddress(message.to);
  const literal = isIP(config.host);
  let address = config.host;
  if (!literal) {
    try {
      address = (await resolveWithinDeadline(config.host, options.resolve))[0]!.address;
    } catch {
      throw new SmtpError("connect", 0);
    }
  }
  const tlsOptions = {
    ...(literal ? {} : { servername: config.host }),
    ...(options.ca ? { ca: options.ca } : {}),
    rejectUnauthorized: true,
  };
  let socket: net.Socket = config.secure
    ? tls.connect({ host: address, port: config.port, ...tlsOptions })
    : net.connect({ host: address, port: config.port });
  socket.setTimeout(timeoutMs, () => socket.destroy(new Error("timeout")));
  try {
    await connected(socket, config.secure ? "secureConnect" : "connect", Math.min(timeoutMs, 10_000), "connect");
    const conversation = new Conversation(socket, timeoutMs);
    const greeting = await conversation.reply("greeting");
    if (greeting.code !== 220) throw new SmtpError("greeting", greeting.code);
    const name = options.clientName ?? "letagents";
    let capabilities = await conversation.command("ehlo", `EHLO ${name}`, [250]);
    if (!config.secure) {
      // smtp:// must upgrade before credentials or mail travel.
      if (!capabilities.some((line) => /^STARTTLS\b/i.test(line))) throw new SmtpError("starttls", 0);
      await conversation.command("starttls", "STARTTLS", [220]);
      // Anything after the 220 in plain text is not from the TLS session: someone on the path wrote it.
      if (conversation.hasUnread()) throw new SmtpError("starttls", 0);
      const plain = conversation.detach();
      socket = tls.connect({ socket: plain, ...tlsOptions });
      await connected(socket, "secureConnect", Math.min(timeoutMs, 10_000), "starttls");
      conversation.attach(socket);
      capabilities = await conversation.command("ehlo", `EHLO ${name}`, [250]);
    }
    if (config.username) {
      const mechanisms = capabilities.find((line) => /^AUTH\b/i.test(line))?.toUpperCase().split(/[\s=]+/).slice(1) ?? [];
      const encode = (value: string) => Buffer.from(value, "utf8").toString("base64");
      if (mechanisms.includes("PLAIN")) {
        await conversation.command("auth", `AUTH PLAIN ${encode(`\u0000${config.username}\u0000${config.password ?? ""}`)}`, [235]);
      } else if (mechanisms.includes("LOGIN")) {
        await conversation.command("auth", "AUTH LOGIN", [334]);
        await conversation.command("auth", encode(config.username), [334]);
        await conversation.command("auth", encode(config.password ?? ""), [235]);
      } else throw new SmtpError("auth", 0);
    }
    await conversation.command("mail", `MAIL FROM:<${envelopeFrom}>`, [250]);
    await conversation.command("rcpt", `RCPT TO:<${recipient}>`, [250, 251]);
    await conversation.command("data", "DATA", [354]);
    conversation.write(`${dotStuff(buildMimeMessage(message, options.now))}\r\n.\r\n`);
    const accepted = await conversation.reply("data");
    if (accepted.code !== 250) throw new SmtpError("data", accepted.code);
    // The message is accepted; say goodbye politely, but never wait long for it.
    conversation.write("QUIT\r\n");
    let farewell: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      conversation.reply("data").catch(() => undefined),
      new Promise((resolve) => { farewell = setTimeout(resolve, 1_000); }),
    ]);
    clearTimeout(farewell);
  } finally {
    socket.destroy();
  }
}
