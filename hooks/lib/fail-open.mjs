// CC 2.1.299 refuses an action when its gating hook cannot answer in time, so ours must always
// answer inside the hooks.json timeout. This backstop prints "no decision" if something hangs past
// `ms`; the timer is unref'd, so a hook that finishes normally never reaches it.
export function failOpenAfter(ms, answer = "{}") {
  const t = setTimeout(() => {
    try { process.stdout.write(answer); } catch {}
    process.exit(0);
  }, ms);
  t.unref();
  return t;
}

// stdin that gives up: a host that never closes the pipe must not hold the hook past its budget.
export function readStdinWithin(ms) {
  return new Promise(res => {
    let d = ""; process.stdin.setEncoding("utf8");
    process.stdin.on("data", c => { d += c; });
    process.stdin.on("end", () => res(d));
    process.stdin.on("error", () => res(d));
    setTimeout(() => res(d), ms).unref();
  });
}
