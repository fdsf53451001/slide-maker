// 終端報告：收集每個 spec 的 pass/fail/skip + 耗時，最後印總表。無依賴 ANSI 色碼。
const useColor = process.stdout.isTTY && process.env.NO_COLOR === undefined;
const paint = (code, text) => (useColor ? `[${code}m${text}[0m` : text);
const c = {
  green: (t) => paint("32", t),
  red: (t) => paint("31", t),
  yellow: (t) => paint("33", t),
  dim: (t) => paint("2", t),
  bold: (t) => paint("1", t),
  cyan: (t) => paint("36", t),
};

export class Report {
  #results = [];

  record(result) {
    this.#results.push(result);
    const ms = `${result.durationMs.toFixed(0)}ms`;
    if (result.status === "pass") console.log(`  ${c.green("✔ PASS")} ${result.name} ${c.dim(ms)}`);
    else if (result.status === "skip")
      console.log(`  ${c.yellow("⊘ SKIP")} ${result.name} ${c.dim(`(${result.reason})`)}`);
    else {
      console.log(`  ${c.red("✗ FAIL")} ${result.name} ${c.dim(ms)}`);
      console.log(c.red(`      ${result.error?.message ?? result.error}`));
      if (result.error?.stack) console.log(c.dim(indentStack(result.error.stack)));
    }
  }

  get results() {
    return this.#results;
  }

  get failed() {
    return this.#results.filter((r) => r.status === "fail");
  }

  /** 印總表；回傳 process 退出碼（有 fail → 1）。 */
  summarize(artifactsDir) {
    const pass = this.#results.filter((r) => r.status === "pass").length;
    const fail = this.failed.length;
    const skip = this.#results.filter((r) => r.status === "skip").length;
    const total = this.#results.length;
    const totalMs = this.#results.reduce((sum, r) => sum + r.durationMs, 0);

    console.log("");
    console.log(c.bold("──────────────────────────────────────────────────────────"));
    console.log(
      `${c.bold("E2E summary")}  ${c.green(`${pass} passed`)}, ${
        fail ? c.red(`${fail} failed`) : `${fail} failed`
      }, ${skip ? c.yellow(`${skip} skipped`) : `${skip} skipped`}  ${c.dim(`(${total} specs, ${(totalMs / 1000).toFixed(1)}s)`)}`,
    );
    if (fail) {
      console.log(c.red("Failures:"));
      for (const r of this.failed)
        console.log(c.red(`  • ${r.name}: ${r.error?.message ?? r.error}`));
    }
    console.log(`${c.dim("Artifacts:")} ${c.cyan(artifactsDir)}`);
    console.log(c.bold("──────────────────────────────────────────────────────────"));
    return fail ? 1 : 0;
  }
}

function indentStack(stack) {
  return stack
    .split("\n")
    .slice(1, 5)
    .map((line) => `      ${line.trim()}`)
    .join("\n");
}

export function heading(text) {
  console.log("");
  console.log(c.bold(c.cyan(text)));
}
