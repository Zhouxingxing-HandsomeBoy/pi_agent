/**
 * Pi Test-Engine Extension
 *
 * Web/UI 自动化测试引擎（测试工程师数字员工核心能力）：
 *   1. Playwright 驱动的浏览器工具集（navigate / snapshot / click / type /
 *      press / assert / screenshot / evaluate / wait）。
 *   2. 轻量断点续传：checkpoint 仅存进度元数据（测试 ID、步骤索引、最近
 *      URL、已通过断言），不存截图 / DOM / a11y 快照。恢复时由模型重新
 *      navigate 到 lastUrl 重建页面状态，兼容 Browser Agent 工作流。
 *   3. 测试报告：Markdown 报告落盘（截图仅用于人工查看的报告存档），
 *      摘要由模型回写飞书。
 *
 * Config (environment variables):
 *   TEST_ENGINE_BROWSER        (optional, default msedge) channel: msedge | chrome | chromium
 *   TEST_ENGINE_HEADLESS       (optional, default "1") set "0" to show the browser window
 *   TEST_ENGINE_REPORT_DIR     (optional) report output dir (default ~/.pi/test-engine/reports)
 *   TEST_ENGINE_CHECKPOINT_DIR (optional) checkpoint dir (default ~/.pi/test-engine/checkpoints)
 *
 * Suggested workflow for the agent:
 *   test_start -> browser_navigate -> browser_snapshot/click/type/assert ... -> test_report
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type Browser, chromium, type Page } from "playwright";
import { Type } from "typebox";

const REPORT_DIR = process.env.TEST_ENGINE_REPORT_DIR || path.join(os.homedir(), ".pi", "test-engine", "reports");
const CHECKPOINT_DIR =
	process.env.TEST_ENGINE_CHECKPOINT_DIR || path.join(os.homedir(), ".pi", "test-engine", "checkpoints");
const BROWSER_CHANNEL = process.env.TEST_ENGINE_BROWSER || "msedge";
const HEADLESS = process.env.TEST_ENGINE_HEADLESS !== "0";

// ---------------------------------------------------------------------------
// Browser session (module-level singleton, reused across tool calls)
// ---------------------------------------------------------------------------

let browser: Browser | null = null;
let page: Page | null = null;

async function ensurePage(): Promise<Page> {
	if (!browser) {
		try {
			browser = await chromium.launch({ channel: BROWSER_CHANNEL, headless: HEADLESS });
		} catch (err) {
			console.warn(
				`[test-engine] channel ${BROWSER_CHANNEL} unavailable (${String(err)}); falling back to bundled chromium`,
			);
			browser = await chromium.launch({ headless: HEADLESS });
		}
	}
	if (!page) {
		page = await browser.newPage();
	}
	return page;
}

function truncate(s: string, n = 8000): string {
	if (s.length <= n) return s;
	return `${s.slice(0, n)}\n... (truncated, ${s.length - n} more chars)`;
}

// ---------------------------------------------------------------------------
// Checkpoint (lightweight progress metadata only — no snapshots/screenshots)
// ---------------------------------------------------------------------------

interface CheckpointState {
	testId: string;
	name: string;
	startedAt: string;
	updatedAt: string;
	stepIndex: number;
	lastUrl?: string;
	passedAsserts: string[];
	status: "running" | "passed" | "failed";
}

let activeCheckpoint: CheckpointState | null = null;

function checkpointFile(testId: string): string {
	return path.join(CHECKPOINT_DIR, `${testId}.json`);
}

function saveCheckpoint(): void {
	if (!activeCheckpoint) return;
	activeCheckpoint.updatedAt = new Date().toISOString();
	fs.mkdirSync(CHECKPOINT_DIR, { recursive: true });
	fs.writeFileSync(checkpointFile(activeCheckpoint.testId), JSON.stringify(activeCheckpoint, null, 2));
}

/** Record one tool step into the active checkpoint (cheap metadata write). */
function step(): void {
	if (activeCheckpoint) {
		activeCheckpoint.stepIndex += 1;
		saveCheckpoint();
	}
}

// ---------------------------------------------------------------------------
// Assertion helper
// ---------------------------------------------------------------------------

async function runAssert(
	target: string,
	op: string,
	value: string,
): Promise<{ passed: boolean; actual: string; message: string }> {
	const p = await ensurePage();
	let actual = "";
	if (target === "title") {
		actual = await p.title();
	} else if (target === "url") {
		actual = p.url();
	} else if (target === "text") {
		actual = await p.locator("body").innerText();
	} else {
		throw new Error(`unknown assert target: ${target} (use title | url | text)`);
	}

	let passed = false;
	if (op === "contains") passed = actual.includes(value);
	else if (op === "notContains") passed = !actual.includes(value);
	else if (op === "equals") passed = actual === value;
	else if (op === "regex") passed = new RegExp(value).test(actual);
	else throw new Error(`unknown operator: ${op} (use contains | notContains | equals | regex)`);

	const actualPreview = actual.slice(0, 300);
	return {
		passed,
		actual: actualPreview,
		message: passed
			? `PASS: ${target} ${op} "${value}"`
			: `FAIL: expected ${target} ${op} "${value}", actual: ${actualPreview}`,
	};
}

// ---------------------------------------------------------------------------
// Extension entry
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI): void {
	// -------------------------------------------------------------------------
	// browser_navigate
	// -------------------------------------------------------------------------
	pi.registerTool({
		name: "browser_navigate",
		label: "Browser Navigate",
		description:
			"Open a URL in the browser. Returns page title, URL and a truncated accessibility snapshot of the page. Use this to start a web test or to restore state from a checkpoint (navigate to lastUrl).",
		parameters: Type.Object({
			url: Type.String({ description: "Full URL to open, e.g. https://example.com/login" }),
		}),
		async execute(_toolCallId, params) {
			step();
			const p = await ensurePage();
			await p.goto(params.url, { waitUntil: "domcontentloaded", timeout: 30_000 });
			if (activeCheckpoint) {
				activeCheckpoint.lastUrl = p.url();
				saveCheckpoint();
			}
			const snapshot = await p.locator("body").ariaSnapshot();
			return {
				content: [
					{
						type: "text",
						text: `Navigated to ${p.url()}\nTitle: ${await p.title()}\n\nAccessibility snapshot:\n${truncate(snapshot)}`,
					},
				],
				details: { url: p.url(), title: await p.title() },
			};
		},
	});

	// -------------------------------------------------------------------------
	// browser_snapshot
	// -------------------------------------------------------------------------
	pi.registerTool({
		name: "browser_snapshot",
		label: "Browser Snapshot",
		description:
			"Get the current page accessibility snapshot (roles, names, texts). Use this to observe the current page state before deciding the next action.",
		parameters: Type.Object({}),
		async execute() {
			step();
			const p = await ensurePage();
			const snapshot = await p.locator("body").ariaSnapshot();
			return {
				content: [{ type: "text", text: `URL: ${p.url()}\nTitle: ${await p.title()}\n\n${truncate(snapshot)}` }],
				details: { url: p.url() },
			};
		},
	});

	// -------------------------------------------------------------------------
	// browser_click
	// -------------------------------------------------------------------------
	pi.registerTool({
		name: "browser_click",
		label: "Browser Click",
		description:
			"Click an element on the page. Prefer matching by visible text; use a CSS selector when text is ambiguous. The snapshot shows which elements are clickable (button/link roles).",
		parameters: Type.Object({
			text: Type.Optional(Type.String({ description: "Visible text of the element to click (preferred)" })),
			selector: Type.Optional(Type.String({ description: "CSS selector fallback, e.g. #login-btn" })),
			index: Type.Optional(
				Type.Number({ description: "Zero-based index when multiple elements match (default 0)" }),
			),
		}),
		async execute(_toolCallId, params) {
			step();
			const p = await ensurePage();
			if (params.text) {
				const locator = p.getByText(params.text, { exact: false }).nth(params.index ?? 0);
				await locator.click({ timeout: 10_000 });
			} else if (params.selector) {
				await p
					.locator(params.selector)
					.nth(params.index ?? 0)
					.click({ timeout: 10_000 });
			} else {
				throw new Error("provide text or selector");
			}
			await p.waitForLoadState("domcontentloaded").catch(() => {});
			return {
				content: [{ type: "text", text: `Clicked. URL: ${p.url()}` }],
				details: { url: p.url() },
			};
		},
	});

	// -------------------------------------------------------------------------
	// browser_type
	// -------------------------------------------------------------------------
	pi.registerTool({
		name: "browser_type",
		label: "Browser Type",
		description:
			"Type text into the focused element or a target element (clears existing value first). Click the input first, or pass a selector.",
		parameters: Type.Object({
			text: Type.String({ description: "Text to type" }),
			selector: Type.Optional(
				Type.String({ description: "CSS selector of the input; omit to type into the focused element" }),
			),
		}),
		async execute(_toolCallId, params) {
			step();
			const p = await ensurePage();
			const target = params.selector ? p.locator(params.selector).first() : p.locator(":focus");
			await target.fill("").catch(() => {});
			if (params.selector) {
				await target.click({ timeout: 10_000 });
				await target.press("ControlOrMeta+A").catch(() => {});
			}
			await target.type(params.text, { delay: 20 });
			return {
				content: [{ type: "text", text: `Typed "${params.text}"` }],
				details: {},
			};
		},
	});

	// -------------------------------------------------------------------------
	// browser_press
	// -------------------------------------------------------------------------
	pi.registerTool({
		name: "browser_press",
		label: "Browser Press",
		description: "Press a keyboard key, e.g. Enter, Escape, Tab, ArrowDown. Useful for submitting forms.",
		parameters: Type.Object({
			key: Type.String({ description: "Key name, e.g. Enter, Escape, Tab, ArrowDown" }),
		}),
		async execute(_toolCallId, params) {
			step();
			const p = await ensurePage();
			await p.keyboard.press(params.key);
			await p.waitForLoadState("domcontentloaded").catch(() => {});
			return {
				content: [{ type: "text", text: `Pressed ${params.key}. URL: ${p.url()}` }],
				details: {},
			};
		},
	});

	// -------------------------------------------------------------------------
	// browser_assert
	// -------------------------------------------------------------------------
	pi.registerTool({
		name: "browser_assert",
		label: "Browser Assert",
		description:
			"Assert a condition about the current page: title, url, or visible body text, using contains / notContains / equals / regex. Returns PASS/FAIL with the actual value. Passed assertions are recorded in the checkpoint.",
		parameters: Type.Object({
			target: Type.Union([Type.Literal("title"), Type.Literal("url"), Type.Literal("text")]),
			op: Type.Union([
				Type.Literal("contains"),
				Type.Literal("notContains"),
				Type.Literal("equals"),
				Type.Literal("regex"),
			]),
			value: Type.String({ description: "Expected value or regex pattern" }),
		}),
		async execute(_toolCallId, params) {
			step();
			const result = await runAssert(params.target, params.op, params.value);
			if (result.passed && activeCheckpoint) {
				activeCheckpoint.passedAsserts.push(`${params.target} ${params.op} "${params.value}"`);
				saveCheckpoint();
			}
			return {
				content: [{ type: "text", text: result.message }],
				details: result,
			};
		},
	});

	// -------------------------------------------------------------------------
	// browser_screenshot
	// -------------------------------------------------------------------------
	pi.registerTool({
		name: "browser_screenshot",
		label: "Browser Screenshot",
		description:
			"Take a screenshot of the current page and save it to the test report directory. Screenshots are for human-readable reports only; they are NOT stored in checkpoints.",
		parameters: Type.Object({
			name: Type.String({ description: "File name without extension, e.g. login-success" }),
		}),
		async execute(_toolCallId, params) {
			step();
			const p = await ensurePage();
			fs.mkdirSync(REPORT_DIR, { recursive: true });
			const file = path.join(REPORT_DIR, `${params.name}-${Date.now()}.png`);
			await p.screenshot({ path: file, fullPage: true });
			return {
				content: [{ type: "text", text: `Screenshot saved: ${file}` }],
				details: { path: file },
			};
		},
	});

	// -------------------------------------------------------------------------
	// browser_evaluate
	// -------------------------------------------------------------------------
	pi.registerTool({
		name: "browser_evaluate",
		label: "Browser Evaluate",
		description:
			"Run a JavaScript expression in the page context and return the JSON-serialized result. Use for reading state that the snapshot does not expose.",
		parameters: Type.Object({
			script: Type.String({
				description: "JavaScript expression, e.g. document.querySelector('#result').innerText",
			}),
		}),
		async execute(_toolCallId, params): Promise<AgentToolResult<{ error?: string; result?: unknown }>> {
			step();
			const p = await ensurePage();
			let result: unknown;
			try {
				result = await p.evaluate(`(() => { const r = (${params.script}); return r === undefined ? null : r; })()`);
			} catch (err) {
				return {
					content: [{ type: "text", text: `Evaluate error: ${String(err)}` }],
					details: { error: String(err) },
				};
			}
			const text = typeof result === "string" ? result : JSON.stringify(result);
			return {
				content: [{ type: "text", text: truncate(text, 4000) }],
				details: { result },
			};
		},
	});

	// -------------------------------------------------------------------------
	// browser_wait
	// -------------------------------------------------------------------------
	pi.registerTool({
		name: "browser_wait",
		label: "Browser Wait",
		description: "Wait for a fixed delay or until specific text appears on the page.",
		parameters: Type.Object({
			ms: Type.Optional(Type.Number({ description: "Milliseconds to wait" })),
			text: Type.Optional(Type.String({ description: "Wait until this text appears (timeout 15s)" })),
		}),
		async execute(_toolCallId, params) {
			step();
			const p = await ensurePage();
			if (params.text) {
				await p.getByText(params.text, { exact: false }).first().waitFor({ timeout: 15_000 });
				return {
					content: [{ type: "text", text: `Text "${params.text}" appeared.` }],
					details: {},
				};
			}
			await p.waitForTimeout(params.ms ?? 1000);
			return {
				content: [{ type: "text", text: `Waited ${params.ms ?? 1000}ms.` }],
				details: {},
			};
		},
	});

	// -------------------------------------------------------------------------
	// test_start
	// -------------------------------------------------------------------------
	pi.registerTool({
		name: "test_start",
		label: "Test Start",
		description:
			"Start a web test session and create a checkpoint. The checkpoint records lightweight progress metadata only (step index, last URL, passed assertions). Call this before browser_navigate.",
		parameters: Type.Object({
			name: Type.String({ description: "Short test name, e.g. login-flow" }),
		}),
		async execute(_toolCallId, params) {
			const testId = `${params.name}-${Date.now()}`;
			activeCheckpoint = {
				testId,
				name: params.name,
				startedAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
				stepIndex: 0,
				passedAsserts: [],
				status: "running",
			};
			saveCheckpoint();
			return {
				content: [{ type: "text", text: `Test started: ${testId}` }],
				details: { testId },
			};
		},
	});

	// -------------------------------------------------------------------------
	// test_finish
	// -------------------------------------------------------------------------
	pi.registerTool({
		name: "test_finish",
		label: "Test Finish",
		description: "Finish the active test session and mark the checkpoint as passed or failed.",
		parameters: Type.Object({
			status: Type.Union([Type.Literal("passed"), Type.Literal("failed")]),
		}),
		async execute(_toolCallId, params) {
			if (!activeCheckpoint) {
				throw new Error("no active test; call test_start first");
			}
			activeCheckpoint.status = params.status;
			saveCheckpoint();
			const testId = activeCheckpoint.testId;
			activeCheckpoint = null;
			return {
				content: [{ type: "text", text: `Test finished: ${testId} (${params.status})` }],
				details: { testId, status: params.status },
			};
		},
	});

	// -------------------------------------------------------------------------
	// test_resume
	// -------------------------------------------------------------------------
	pi.registerTool({
		name: "test_resume",
		label: "Test Resume",
		description:
			"Resume an interrupted test from its checkpoint. Returns the progress metadata (step index, last URL, passed assertions). After this, call browser_navigate with lastUrl to rebuild page state, then continue from the next step.",
		parameters: Type.Object({
			testId: Type.String({ description: "Checkpoint test id" }),
		}),
		async execute(_toolCallId, params) {
			const file = checkpointFile(params.testId);
			if (!fs.existsSync(file)) {
				return {
					content: [{ type: "text", text: `Checkpoint not found: ${file}` }],
					details: { found: false },
				};
			}
			const data = JSON.parse(fs.readFileSync(file, "utf8")) as CheckpointState;
			activeCheckpoint = data;
			return {
				content: [
					{
						type: "text",
						text: `Resumed test "${data.name}" (${data.testId})\nstatus=${data.status} stepIndex=${data.stepIndex} lastUrl=${data.lastUrl ?? "(none)"}\npassedAsserts=${data.passedAsserts.length}`,
					},
				],
				details: { found: true, ...data },
			};
		},
	});

	// -------------------------------------------------------------------------
	// test_report
	// -------------------------------------------------------------------------
	pi.registerTool({
		name: "test_report",
		label: "Test Report",
		description:
			"Generate a Markdown test report for the active test session and save it to the report directory. Returns the report path and a summary. The agent should relay the summary to the user (e.g. via Feishu).",
		parameters: Type.Object({
			summary: Type.String({ description: "Test result summary, e.g. '登录流程通过：3/3 断言通过'" }),
		}),
		async execute(_toolCallId, params) {
			const cp = activeCheckpoint;
			const reportId = `${cp?.name ?? "test"}-${Date.now()}`;
			fs.mkdirSync(REPORT_DIR, { recursive: true });
			const file = path.join(REPORT_DIR, `${reportId}.md`);
			const lines = [
				`# 测试报告: ${cp?.name ?? "(未命名)"}`,
				"",
				`- 测试 ID: ${cp?.testId ?? "(未使用 test_start)"}`,
				`- 开始时间: ${cp?.startedAt ?? "-"}`,
				`- 结束时间: ${new Date().toISOString()}`,
				`- 执行步骤数: ${cp?.stepIndex ?? 0}`,
				`- 状态: ${cp?.status ?? "running"}`,
				"",
				"## 通过的断言",
				"",
				...(cp?.passedAsserts.length ? cp.passedAsserts.map((a) => `- [PASS] ${a}`) : ["（无）"]),
				"",
				"## 总结",
				"",
				params.summary,
				"",
			];
			fs.writeFileSync(file, lines.join("\n"), "utf8");
			return {
				content: [
					{
						type: "text",
						text: `Report saved: ${file}\n\nSummary: ${params.summary}`,
					},
				],
				details: { path: file },
			};
		},
	});
}
