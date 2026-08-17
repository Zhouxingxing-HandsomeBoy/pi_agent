/**
 * Pi Feishu (Lark) Bot Extension
 *
 * Turns a running pi agent into a Feishu bot:
 *   1. Feishu pushes a message event to the webhook exposed by this extension.
 *   2. The extension injects the message into the running agent via
 *      `pi.sendUserMessage(text)` (idle user messages always trigger a turn).
 *   3. When the agent settles, the final assistant text is sent back to the
 *      same Feishu chat via the OpenAPI `im/v1/messages` endpoint.
 *
 * Auth model: Feishu open-platform app (app_id + app_secret -> tenant_access_token).
 * Event security: optional Encrypt Key (AES-256-CBC) and/or Verification Token.
 *
 * Config (environment variables):
 *   FEISHU_APP_ID              (required) app id from Feishu developer console
 *   FEISHU_APP_SECRET         (required) app secret
 *   FEISHU_ENCRYPT_KEY        (optional) event encryption key; enables decryption
 *   FEISHU_VERIFICATION_TOKEN (optional) verify the `token` field of callbacks
 *   FEISHU_PORT               (optional, default 3000) webhook listen port
 *   FEISHU_PATH               (optional, default /feishu/event) webhook path
 *   FEISHU_RECEIVE_ID_TYPE    (optional, default chat_id) receive_id_type for replies
 *
 * Commands:
 *   /feishu-status   show webhook + token status
 *   /feishu-send <chat_id> <text>   send a test message to a chat
 *
 * Deploy note: Feishu requires a public HTTPS endpoint. Use ngrok / localhost.run
 * during development, or deploy behind a TLS terminator in production.
 */

import * as http from "node:http";
import * as crypto from "node:crypto";
import type { ExtensionAPI, ExtensionContext, MessageEndEvent } from "@earendil-works/pi-coding-agent";

const FEISHU_BASE = "https://open.feishu.cn";

interface FeishuConfig {
	appId: string;
	appSecret: string;
	encryptKey?: string;
	verificationToken?: string;
	port: number;
	path: string;
	receiveIdType: string;
}

interface TokenCache {
	token: string;
	expiresAt: number; // epoch ms
}

interface FeishuMessageEvent {
	message_id?: string;
	chat_id?: string;
	content?: string;
	message_type?: string;
}

interface FeishuCallback {
	type?: string;
	challenge?: string;
	token?: string;
	encrypt?: string;
	header?: { event_type?: string; token?: string };
	event?: {
		sender?: { sender_type?: string; sender_id?: { open_id?: string } };
		message?: FeishuMessageEvent;
	};
}

function loadConfig(): FeishuConfig | null {
	const appId = process.env.FEISHU_APP_ID;
	const appSecret = process.env.FEISHU_APP_SECRET;
	if (!appId || !appSecret) {
		console.warn(
			"[feishu-bot] FEISHU_APP_ID / FEISHU_APP_SECRET not set; Feishu bot disabled. " +
				"Set them (and optionally FEISHU_ENCRYPT_KEY / FEISHU_VERIFICATION_TOKEN) to enable.",
		);
		return null;
	}
	return {
		appId,
		appSecret,
		encryptKey: process.env.FEISHU_ENCRYPT_KEY || undefined,
		verificationToken: process.env.FEISHU_VERIFICATION_TOKEN || undefined,
		port: Number(process.env.FEISHU_PORT) || 3000,
		path: process.env.FEISHU_PATH || "/feishu/event",
		receiveIdType: process.env.FEISHU_RECEIVE_ID_TYPE || "chat_id",
	};
}

// ---------------------------------------------------------------------------
// Feishu crypto: AES-256-CBC, key = SHA256(encryptKey), IV = first 16 bytes
// of the base64-decoded buffer, PKCS7 padding.
// ---------------------------------------------------------------------------

function decrypt(encryptKey: string, b64: string): string {
	const key = crypto.createHash("sha256").update(encryptKey).digest();
	const data = Buffer.from(b64, "base64");
	const iv = data.subarray(0, 16);
	const cipher = data.subarray(16);
	const decipher = crypto.createDecipheriv("aes-256-cbc", key, iv);
	const decrypted = Buffer.concat([decipher.update(cipher), decipher.final()]);
	const pad = decrypted[decrypted.length - 1];
	return decrypted.subarray(0, decrypted.length - pad).toString("utf8");
}

// ---------------------------------------------------------------------------
// Feishu OpenAPI client
// ---------------------------------------------------------------------------

class FeishuClient {
	private tokenCache: TokenCache | null = null;

	constructor(private cfg: FeishuConfig) {}

	private async getTenantToken(): Promise<string> {
		if (this.tokenCache && this.tokenCache.expiresAt > Date.now() + 60_000) {
			return this.tokenCache.token;
		}
		const res = await fetch(`${FEISHU_BASE}/open-apis/auth/v3/tenant_access_token/internal`, {
			method: "POST",
			headers: { "Content-Type": "application/json; charset=utf-8" },
			body: JSON.stringify({ app_id: this.cfg.appId, app_secret: this.cfg.appSecret }),
		});
		const data = (await res.json()) as { code: number; msg: string; tenant_access_token?: string; expire?: number };
		if (data.code !== 0 || !data.tenant_access_token) {
			throw new Error(`tenant_access_token failed: ${data.code} ${data.msg}`);
		}
		this.tokenCache = {
			token: data.tenant_access_token,
			expiresAt: Date.now() + (data.expire ?? 7200) * 1000,
		};
		return this.tokenCache.token;
	}

	async sendMessage(receiveId: string, text: string): Promise<void> {
		const token = await this.getTenantToken();
		const url = `${FEISHU_BASE}/open-apis/im/v1/messages?receive_id_type=${encodeURIComponent(this.cfg.receiveIdType)}`;
		const res = await fetch(url, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${token}`,
				"Content-Type": "application/json; charset=utf-8",
			},
			body: JSON.stringify({
				receive_id: receiveId,
				msg_type: "text",
				content: JSON.stringify({ text }),
			}),
		});
		const data = (await res.json()) as { code: number; msg: string };
		if (data.code !== 0) {
			throw new Error(`send_message failed: ${data.code} ${data.msg}`);
		}
	}
}

// ---------------------------------------------------------------------------
// Reply capture: accumulate assistant text, flush on agent_settled.
// ---------------------------------------------------------------------------

function extractText(content: unknown): string {
	if (!Array.isArray(content)) return "";
	let out = "";
	for (const block of content as Array<{ type?: string; text?: string }>) {
		if (block && block.type === "text" && typeof block.text === "string") {
			out += block.text;
		}
	}
	return out;
}

export default function (pi: ExtensionAPI) {
	const cfg = loadConfig();
	if (!cfg) return;

	const client = new FeishuClient(cfg);

	// Per-chat serialized processing so we never call sendUserMessage while busy.
	const chatQueues = new Map<string, Promise<void>>();
	const seenMessageIds = new Set<string>();

	// Reply capture state (single in-flight run at a time thanks to the queue).
	let replyBuffer = "";
	let resolveReply: ((text: string) => void) | null = null;

	pi.on("message_end", (event: MessageEndEvent) => {
		const msg = event.message as { role?: string; content?: unknown };
		if (msg.role === "assistant") {
			replyBuffer += extractText(msg.content);
		}
	});

	pi.on("agent_settled", () => {
		if (resolveReply) {
			const r = resolveReply;
			resolveReply = null;
			r(replyBuffer);
		}
	});

	function processMessage(text: string, chatId: string): Promise<void> {
		return new Promise<void>((resolve) => {
			replyBuffer = "";
			const done = new Promise<string>((res) => {
				resolveReply = res;
			});

			const reply = async () => {
				try {
					pi.sendUserMessage(text);
				} catch (err) {
					resolveReply = null;
					await client.sendMessage(chatId, `⚠️ 无法处理消息：${String(err)}`).catch(() => {});
					resolve();
					return;
				}
				const answer = await done;
				await client.sendMessage(chatId, answer || "(无文本回复)").catch((e) => {
					console.error("[feishu-bot] send reply failed:", e);
				});
				resolve();
			};
			void reply();
		});
	}

	function enqueue(chatId: string, text: string): void {
		const prev = chatQueues.get(chatId) ?? Promise.resolve();
		const next = prev.then(() => processMessage(text, chatId)).catch((e) => {
			console.error("[feishu-bot] processing error:", e);
		});
		chatQueues.set(chatId, next);
	}

	// -------------------------------------------------------------------------
	// Webhook HTTP server
	// -------------------------------------------------------------------------

	const server = http.createServer((req, res) => {
		if (req.method !== "POST" || req.url?.split("?")[0] !== cfg.path) {
			res.writeHead(405).end("Method Not Allowed");
			return;
		}

		const chunks: Buffer[] = [];
		req.on("data", (c) => chunks.push(c));
		req.on("end", () => {
			let raw: string;
			try {
				raw = Buffer.concat(chunks).toString("utf8");
			} catch {
				res.writeHead(400).end("Bad Request");
				return;
			}

			let payload: FeishuCallback;
			try {
				payload = JSON.parse(raw) as FeishuCallback;
			} catch {
				res.writeHead(400).end("Invalid JSON");
				return;
			}

			// Encrypted callbacks wrap everything in { encrypt: "..." }.
			if (payload.encrypt && cfg.encryptKey) {
				try {
					payload = JSON.parse(decrypt(cfg.encryptKey, payload.encrypt)) as FeishuCallback;
				} catch (e) {
					console.error("[feishu-bot] decrypt failed:", e);
					res.writeHead(400).end("Decrypt Failed");
					return;
				}
			} else if (payload.encrypt && !cfg.encryptKey) {
				res.writeHead(400).end("Encryption configured on Feishu but FEISHU_ENCRYPT_KEY missing");
				return;
			}

			// URL verification challenge.
			if (payload.type === "url_verification") {
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ challenge: payload.challenge }));
				return;
			}

			// Optional token verification.
			const token = payload.token ?? payload.header?.token;
			if (cfg.verificationToken && token && token !== cfg.verificationToken) {
				res.writeHead(403).end("Token Mismatch");
				return;
			}

			// Acknowledge immediately (Feishu requires <1s), process async.
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ code: 0, msg: "success" }));

			const event = payload.event;
			if (!event || payload.header?.event_type !== "im.message.receive_v1") return;

			const message = event.message;
			const sender = event.sender;
			if (!message || !message.content) return;

			// Skip messages sent by the bot itself to avoid loops.
			if (sender?.sender_type === "app") return;

			const messageId = message.message_id;
			if (messageId) {
				if (seenMessageIds.has(messageId)) return;
				seenMessageIds.add(messageId);
				if (seenMessageIds.size > 2000) seenMessageIds.clear();
			}

			const chatId = message.chat_id ?? "";
			let text = "";
			try {
				text = (JSON.parse(message.content) as { text?: string }).text ?? "";
			} catch {
				text = "";
			}
			if (!text.trim()) {
				void client.sendMessage(chatId, "暂仅支持文本消息。").catch(() => {});
				return;
			}

			enqueue(chatId, text);
		});
	});

	server.listen(cfg.port, () => {
		console.log(`[feishu-bot] webhook listening on http://0.0.0.0:${cfg.port}${cfg.path}`);
	});

	// -------------------------------------------------------------------------
	// Commands
	// -------------------------------------------------------------------------

	pi.registerCommand("feishu-status", {
		description: "Show Feishu bot webhook and token status",
		handler: async (_args, ctx: ExtensionContext) => {
			ctx.ui.notify(
				`Feishu bot: port=${cfg.port} path=${cfg.path} encrypt=${cfg.encryptKey ? "on" : "off"} token=${cfg.verificationToken ? "on" : "off"}`,
				"info",
			);
		},
	});

	pi.registerCommand("feishu-send", {
		description: "Send a test message: /feishu-send <chat_id> <text>",
		handler: async (args, ctx: ExtensionContext) => {
			const [chatId, ...rest] = args.split(/\s+/);
			const text = rest.join(" ");
			if (!chatId || !text) {
				ctx.ui.notify("Usage: /feishu-send <chat_id> <text>", "warning");
				return;
			}
			try {
				await client.sendMessage(chatId, text);
				ctx.ui.notify(`Sent to ${chatId}`, "info");
			} catch (e) {
				ctx.ui.notify(`Send failed: ${String(e)}`, "warning");
			}
		},
	});
}
