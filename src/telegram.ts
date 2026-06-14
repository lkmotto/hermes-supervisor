// ─── Telegram Bot integration for Hermes ──────────────────────────
// Uses the Telegram Bot API via native fetch + long polling.
// The bot token is read from TELEGRAM_BOT_TOKEN at runtime (Doppler-injected).
// Never logs, prints, or returns the token value.
// ───────────────────────────────────────────────────────────────────

import { redactSecrets } from "./redact.js";

const TELEGRAM_API_BASE = "https://api.telegram.org";

export interface TelegramBotCallbacks {
  /** Called for /status — must return the Hermes status text. */
  handleStatus: () => Promise<string>;
  /** Called for /cycle — must trigger a business PM loop and return the status report. */
  handleCycle: () => Promise<string>;
  /** Called for freeform text messages — stores an observation. */
  handleText: (chatId: number, userId: number, text: string) => Promise<void>;
}

export class TelegramBot {
  private token: string;
  private callbacks: TelegramBotCallbacks;
  private running = false;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(token: string, callbacks: TelegramBotCallbacks) {
    if (!token || token.trim().length === 0) {
      throw new Error("TELEGRAM_BOT_TOKEN is empty or missing");
    }
    this.token = token.trim();
    this.callbacks = callbacks;
  }

  /** Start long-polling for updates. Non-blocking. */
  start(): void {
    if (this.running) return;
    this.running = true;
    console.error("[telegram] Bot starting (token present, length=" + String(this.token.length) + ")");
    this.poll();
  }

  /** Stop the bot and cancel any pending poll. */
  stop(): void {
    this.running = false;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    console.error("[telegram] Bot stopped");
  }

  private async api(method: string, body: Record<string, unknown>): Promise<unknown> {
    const url = `${TELEGRAM_API_BASE}/bot${this.token}/${method}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Telegram API ${res.status}: ${redactSecrets(errText)}`);
    }
    return res.json();
  }

  private async poll(): Promise<void> {
    if (!this.running) return;

    let offset: number | undefined;
    // Static "last seen" so restarts skip old messages.
    // We also query once before polling to skip the backlog.
    try {
      const init = (await this.api("getUpdates", { limit: 1, timeout: 0 })) as {
        ok: boolean;
        result: Array<{ update_id: number }>;
      };
      if (init.ok && init.result.length > 0) {
        offset = init.result[init.result.length - 1].update_id + 1;
      }
    } catch {
      // Non-fatal: we will pick up old messages on first poll.
    }

    while (this.running) {
      try {
        const data = (await this.api("getUpdates", {
          offset,
          timeout: 30,
          allowed_updates: ["message"],
        })) as { ok: boolean; result: TelegramUpdate[] };

        if (data.ok && data.result.length > 0) {
          for (const update of data.result) {
            offset = update.update_id + 1;
            try {
              await this.handleUpdate(update);
            } catch (err) {
              console.error(
                "[telegram] Error handling update:",
                err instanceof Error ? redactSecrets(err.message) : String(err),
              );
            }
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? redactSecrets(err.message) : String(err);
        console.error("[telegram] Poll error:", msg);
        // Back off briefly before retry.
        await sleep(5000);
      }
    }
  }

  private async handleUpdate(update: TelegramUpdate): Promise<void> {
    const msg = update.message;
    if (!msg?.text) return;

    const chatId = msg.chat.id;
    const userId = msg.from?.id ?? 0;
    const text = msg.text.trim();

    console.error(
      "[telegram] Message from chat=" + String(chatId) +
        " user=" + String(userId) +
        " text_len=" + String(text.length),
    );

    if (text.startsWith("/start")) {
      await this.sendMessage(
        chatId,
        "👋 Hello! I'm Hermes, your business operations PM agent.\n\n" +
          "Commands:\n" +
          "/status — Current operating state\n" +
          "/cycle — Run a business PM cycle\n\n" +
          "You can also send me any text and I'll record it as an observation.",
      );
    } else if (text.startsWith("/status")) {
      const statusText = await this.callbacks.handleStatus();
      await this.sendMessage(chatId, statusText);
    } else if (text.startsWith("/cycle")) {
      await this.sendMessage(chatId, "🔄 Running a business PM cycle…");
      const report = await this.callbacks.handleCycle();
      await this.sendMessage(chatId, report);
    } else {
      // Freeform text → store as observation
      await this.callbacks.handleText(chatId, userId, text);
      await this.sendMessage(chatId, "📝 Observation recorded. I'll factor this into my next cycle.");
    }
  }

  /** Public helper to send a message back to a chat. */
  async sendMessage(chatId: number, text: string): Promise<void> {
    try {
      await this.api("sendMessage", {
        chat_id: chatId,
        text,
        parse_mode: "Markdown",
      });
    } catch {
      // Retry without Markdown parsing on failure
      try {
        await this.api("sendMessage", {
          chat_id: chatId,
          text,
        });
      } catch (err) {
        console.error(
          "[telegram] sendMessage error:",
          err instanceof Error ? redactSecrets(err.message) : String(err),
        );
      }
    }
  }
}

// ─── Telegram API types ──────────────────────────────────────────

interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
}

interface TelegramMessage {
  message_id: number;
  from?: { id: number; first_name?: string; username?: string };
  chat: { id: number; type: string };
  text?: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
