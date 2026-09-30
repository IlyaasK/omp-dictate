// /dictate — live dictation into the composer.
//
//   /dictate        start dictating; the transcript appears while you speak
//   /dictate 20     same, but stop and insert after 20 s
//
// Keys while dictating:
//   Enter           insert the transcript into the composer — editable, NOT sent
//   Esc / Ctrl+C    discard the dictation
//
// The microphone is piped live into `fermion serve`'s WebSocket endpoint
// (GET /v1/audio/stream), which streams `partial` hypotheses and `final`
// segments; Enter closes the stream and inserts the full transcript.
//
// Env overrides:
//   DICTATE_ENDPOINT      default http://127.0.0.1:8000/v1/audio/transcriptions
//                         (the WebSocket endpoint is derived from it)
//   DICTATE_STREAM_URL    explicit WebSocket endpoint, overrides the derivation
//   DICTATE_TARGET        PipeWire source node (e.g. a specific microphone); default = system default
//   DICTATE_MAX_SECONDS   hard cap for a forgotten dictation, default 120

import type { ExtensionAPI, ExtensionCommandContext } from "@oh-my-pi/pi-coding-agent";
import {
	matchesKey,
	replaceTabs,
	truncateToWidth,
	wrapTextWithAnsi,
	type Component,
} from "@oh-my-pi/pi-tui";
import { spawn, type ChildProcess } from "node:child_process";

const ENDPOINT = process.env.DICTATE_ENDPOINT ?? "http://127.0.0.1:8000/v1/audio/transcriptions";
const MAX_SECONDS = Number(process.env.DICTATE_MAX_SECONDS ?? 120);
const SAMPLE_RATE = 16000;
const TICK_MS = 200;
const FLUSH_TIMEOUT_MS = 30_000;
const LEVEL_WIDTH = 12;
const NOISE_LEVEL = 0.003;
const MAX_BODY_LINES = 12;
const BODY_INDENT = "  ";

type Phase = "recording" | "finishing";
type Outcome = { action: "insert" | "cancel"; text: string };

type Session = {
	proc: ChildProcess | undefined;
	ws: WebSocket | undefined;
	wsOpen: boolean;
	closed: boolean;
	queued: Uint8Array[];
	tail: Uint8Array;
	finals: string[];
	partial: string;
	onDone: ((text: string) => void) | undefined;
	phase: Phase;
	startedAt: number;
	level: number;
	muted: boolean;
	stopped: boolean;
};

type ServerMessage = { type: string; text: string | undefined; message: string | undefined };

function streamUrl(): string {
	const explicit = process.env.DICTATE_STREAM_URL;
	if (explicit) return explicit;
	const url = new URL(ENDPOINT);
	url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
	url.pathname = "/v1/audio/stream";
	url.search = "";
	return url.toString();
}

function transcriptOf(session: Session): string {
	return [...session.finals, session.partial]
		.map((part) => part.trim())
		.filter((part) => part.length > 0)
		.join(" ");
}

function parseServerMessage(raw: unknown): ServerMessage | undefined {
	if (typeof raw !== "string") return undefined;
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		return undefined;
	}
	if (typeof value !== "object" || value === null) return undefined;
	// Frames come from our own transcription server; every field is re-checked.
	const frame = value as { type?: unknown; text?: unknown; message?: unknown };
	if (typeof frame.type !== "string") return undefined;
	return {
		type: frame.type,
		text: typeof frame.text === "string" ? frame.text : undefined,
		message: typeof frame.message === "string" ? frame.message : undefined,
	};
}

/** RMS of a sample-aligned f32le block, 0..1 — drives the live level meter. */
function blockLevel(block: Uint8Array): number {
	const samples = new Float32Array(block.buffer, block.byteOffset, block.byteLength / 4);
	let sum = 0;
	for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
	return samples.length > 0 ? Math.sqrt(sum / samples.length) : 0;
}

export default function dictate(pi: ExtensionAPI) {
	let dictating = false;
	let killActive: (() => void) | null = null;

	pi.on("session_shutdown", () => {
		killActive?.();
	});

	pi.registerCommand("dictate", {
		description: "Dictate into the composer — live transcript; Enter inserts without sending",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("dictate: needs the interactive TUI", "warning");
				return;
			}
			if (dictating) {
				ctx.ui.notify("dictate: already dictating", "warning");
				return;
			}

			const requested = Number(String(args).trim());
			const capSeconds = Number.isFinite(requested) && requested > 0 ? requested : MAX_SECONDS;
			const url = streamUrl();
			const target = process.env.DICTATE_TARGET ?? "default source";

			const session: Session = {
				proc: undefined,
				ws: undefined,
				wsOpen: false,
				closed: false,
				queued: [],
				tail: new Uint8Array(0),
				finals: [],
				partial: "",
				onDone: undefined,
				phase: "recording",
				startedAt: Date.now(),
				level: 0,
				muted: false,
				stopped: false,
			};

			let render: () => void = () => {};
			let settle: ((outcome: Outcome) => void) | undefined;
			let stopTimers: () => void = () => {};
			let finished = false;

			function clearTimers() {
				const stop = stopTimers;
				stopTimers = () => {};
				stop();
			}

			/** Sample-aligned PCM into the live stream; late stdout still counts. */
			function feed(bytes: Uint8Array) {
				if (session.closed) return;
				let data = bytes;
				if (session.tail.byteLength > 0) {
					const joined = new Uint8Array(session.tail.byteLength + bytes.byteLength);
					joined.set(session.tail);
					joined.set(bytes, session.tail.byteLength);
					data = joined;
				}
				const usable = data.byteLength - (data.byteLength % 4);
				session.tail = usable === data.byteLength ? new Uint8Array(0) : data.slice(usable);
				if (usable === 0) return;
				const block = data.subarray(0, usable);
				session.level = Math.max(session.level, blockLevel(block));
				if (!session.wsOpen || !session.ws) {
					session.queued.push(block);
					return;
				}
				try {
					session.ws.send(block);
				} catch (error) {
					fail(error instanceof Error ? error.message : String(error));
				}
			}

			function startMic(onError: (message: string) => void) {
				const micArgs = [
					"--rate",
					String(SAMPLE_RATE),
					"--channels",
					"1",
					"--format",
					"f32",
					"--latency",
					"20ms",
					"-a",
				];
				if (process.env.DICTATE_TARGET) micArgs.push("--target", process.env.DICTATE_TARGET);
				micArgs.push("-");

				const proc = spawn("pw-record", micArgs, { stdio: ["ignore", "pipe", "pipe"] });
				session.proc = proc;
				let stderr = "";
				proc.stderr?.setEncoding("utf8");
				proc.stderr?.on("data", (chunk: string) => {
					stderr = (stderr + chunk).slice(-400);
				});
				proc.stdout?.on("data", (chunk: Buffer) => {
					guard(() => feed(new Uint8Array(chunk)));
				});
				proc.on("error", (error) => {
					guard(() => onError(error.message));
				});
				proc.on("exit", (code) => {
					guard(() => {
						if (session.stopped) return;
						session.stopped = true;
						onError(stderr.trim() || `pw-record exited (${code ?? "signal"})`);
					});
				});
			}

			/** SIGTERM the recorder and wait for its buffered stdout to drain. */
			async function stopMic(): Promise<void> {
				const proc = session.proc;
				if (!proc || session.stopped) return;
				session.stopped = true;
				await new Promise<void>((resolve) => {
					const timer = setTimeout(resolve, 500);
					proc.once("exit", () => {
						clearTimeout(timer);
						resolve();
					});
					proc.kill("SIGTERM");
				});
			}

			function closeSocket() {
				session.closed = true;
				session.wsOpen = false;
				const ws = session.ws;
				session.ws = undefined;
				if (!ws) return;
				try {
					ws.close();
				} catch {}
			}

			function startStream() {
				const ws = new WebSocket(url);
				ws.binaryType = "arraybuffer";
				session.ws = ws;
				ws.onopen = () => {
					guard(() => {
						session.wsOpen = true;
						ws.send(JSON.stringify({ sample_rate: SAMPLE_RATE, format: "pcm_f32le" }));
						const queued = session.queued.splice(0);
						for (const chunk of queued) ws.send(chunk);
					});
				};
				ws.onmessage = (event: MessageEvent) => {
					guard(() => {
						const message = parseServerMessage(event.data);
						if (!message) return;
						if (message.type === "partial") {
							session.partial = message.text ?? "";
							render();
							return;
						}
						if (message.type === "final") {
							if (message.text) session.finals.push(message.text);
							session.partial = "";
							render();
							return;
						}
						if (message.type === "done") {
							session.onDone?.(message.text ?? transcriptOf(session));
							return;
						}
						if (message.type === "error") fail(message.message ?? "stream error");
					});
				};
				ws.onerror = () => {
					guard(() => {
						if (!session.wsOpen && session.phase === "recording")
							fail(`cannot reach ${url} — start it with \`fermion serve --model phonon-2\``);
					});
				};
				ws.onclose = () => {
					guard(() => {
						if (session.phase === "finishing" || session.closed) return;
						fail("stream closed before finishing");
					});
				};
			}

			/** Subprocess and socket callbacks run outside handler isolation: never let one throw. */
			function guard(run: () => void) {
				try {
					run();
				} catch (error) {
					fail(error instanceof Error ? error.message : String(error));
				}
			}

			function fail(message: string) {
				ctx.ui.notify(`dictate: ${message}`, "error");
				void finish("cancel").catch(() => {});
			}

			/** Send `end` and wait for the server's full transcript. */
			function flush(): Promise<string> {
				const ws = session.ws;
				if (!ws || !session.wsOpen) return Promise.resolve(transcriptOf(session));
				const { promise, resolve } = Promise.withResolvers<string>();
				let clearFlush: () => void = () => {};
				const settleFlush = (text: string) => {
					if (session.onDone === settleFlush) session.onDone = undefined;
					clearFlush();
					resolve(text);
				};
				session.onDone = settleFlush;
				try {
					ws.send(JSON.stringify({ type: "end" }));
				} catch {
					settleFlush(transcriptOf(session));
					return promise;
				}
				const timer = ctx.setTimeout(() => settleFlush(transcriptOf(session)), FLUSH_TIMEOUT_MS);
				clearFlush = () => ctx.clearTimer(timer);
				return promise;
			}

			async function finish(action: "insert" | "cancel") {
				if (finished) return;
				finished = true;
				session.phase = "finishing";
				clearTimers();
				render();
				if (action === "cancel") {
					session.muted = true;
					closeSocket();
					await stopMic();
					settle?.({ action: "cancel", text: "" });
					return;
				}
				await stopMic();
				const text = await flush();
				closeSocket();
				if (!text.trim()) {
					ctx.ui.notify("dictate: nothing heard", "warning");
					settle?.({ action: "cancel", text: "" });
					return;
				}
				settle?.({ action: "insert", text: text.trim() });
			}

			killActive = () => {
				session.muted = true;
				closeSocket();
				void stopMic();
			};

			dictating = true;
			try {
				const outcome = await ctx.ui.custom<Outcome>((tui, theme, _keybindings, done) => {
					settle = done;
					render = () => tui.requestRender();

					startMic(fail);
					startStream();
					const ticker = ctx.setInterval(() => {
						session.level *= 0.55;
						render();
					}, TICK_MS);
					const capTimer = ctx.setTimeout(() => void finish("insert"), capSeconds * 1000);
					stopTimers = () => {
						ctx.clearTimer(ticker);
						ctx.clearTimer(capTimer);
					};

					const view: Component = {
						render(width: number): readonly string[] {
							const elapsed = (Date.now() - session.startedAt) / 1000;
							const clock = `${Math.floor(elapsed / 60)}:${String(Math.floor(elapsed % 60)).padStart(2, "0")}`;
							const recording = session.phase === "recording";
							const lit =
								session.level < NOISE_LEVEL
									? 0
									: Math.min(LEVEL_WIDTH, Math.round(Math.sqrt(session.level) * 30));
							const meter =
								theme.fg("accent", "▮".repeat(lit)) + theme.fg("dim", "▯".repeat(LEVEL_WIDTH - lit));
							const lines: string[] = [
								`${theme.fg(recording ? "success" : "accent", recording ? "● rec" : "◌ finishing")} ` +
									`${theme.fg("dim", clock)}  ${meter}  ${theme.fg("dim", target)}`,
							];
							if (recording) {
								lines.push(theme.fg("dim", `Enter insert · Esc discard · cap ${capSeconds}s`));
							}
							lines.push("");

							const bodyWidth = Math.max(10, width - BODY_INDENT.length);
							const body: string[] = [];
							const finals = session.finals.join(" ").trim();
							if (finals) {
								for (const line of wrapTextWithAnsi(finals, bodyWidth)) body.push(line);
							}
							if (!session.muted && session.partial.trim()) {
								const partial = wrapTextWithAnsi(session.partial.trim(), Math.max(4, bodyWidth - 1));
								partial.forEach((line, index) =>
									body.push(theme.fg("accent", index === partial.length - 1 ? `${line}▍` : line)),
								);
							} else if (session.phase === "finishing") {
								body.push(theme.fg("dim", "transcribing…"));
							} else if (body.length === 0) {
								body.push(theme.fg("dim", "(listening…)"));
							}

							const shown = body.slice(-MAX_BODY_LINES);
							if (body.length > shown.length) {
								lines.push(
									theme.fg("dim", `${BODY_INDENT}… ${body.length - shown.length} earlier line(s)`),
								);
							}
							for (const line of shown) lines.push(BODY_INDENT + line);
							return lines.map((line) => truncateToWidth(replaceTabs(line), width));
						},
						handleInput(data: string) {
							if (session.phase !== "recording") return;
							if (matchesKey(data, "enter")) {
								void finish("insert");
								return;
							}
							if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) void finish("cancel");
						},
						invalidate() {},
						dispose() {
							session.muted = true;
							clearTimers();
							closeSocket();
							void stopMic();
						},
					};
					return view;
				});

				const existing = ctx.ui.getEditorText();
				if (outcome.action === "insert" && outcome.text) {
					ctx.ui.setEditorText(
						existing.trim().length ? `${existing.replace(/\s+$/, "")} ${outcome.text}` : outcome.text,
					);
				}
			} finally {
				dictating = false;
				killActive = null;
				clearTimers();
				closeSocket();
				void stopMic();
			}
		},
	});
}
